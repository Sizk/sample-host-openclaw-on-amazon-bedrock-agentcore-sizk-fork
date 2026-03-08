/**
 * AgentCore Runtime Contract Server — Per-User Sessions
 *
 * Implements the required HTTP protocol contract for AgentCore Runtime:
 *   - GET  /ping         -> Health check (Healthy — allows idle termination)
 *   - POST /invocations  -> Chat handler with hybrid init
 *
 * Each AgentCore session is dedicated to a single user. On first invocation:
 *   1. Use pre-fetched secrets (fetched eagerly at boot)
 *   2. Start proxy + OpenClaw + workspace restore in parallel
 *   3. Once proxy is ready (~5s), route via lightweight agent shim
 *   4. Once OpenClaw is ready (~2-4 min), route via WebSocket bridge
 *
 * The lightweight agent handles messages immediately while OpenClaw starts.
 * Once OpenClaw is ready, all subsequent messages route through it seamlessly.
 *
 * Runs on port 8080 (required by AgentCore Runtime).
 */

const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const workspaceSync = require("./workspace-sync");
const agent = require("./lightweight-agent");
const scopedCreds = require("./scoped-credentials");
const channelSender = require("./channel-sender");

const { generateOpenClawConfig, PROXY_PORT, OPENCLAW_PORT, SUBAGENT_MODEL_NAME } = require("./openclaw-config");

const PORT = 8080;

// Gateway token — fetched from Secrets Manager eagerly at boot.
// No fallback — container will fail to authenticate WebSocket if not set.
let GATEWAY_TOKEN = null;

// Cognito password secret — fetched from Secrets Manager eagerly at boot.
// Stored in-process only, never written to process.env.
let COGNITO_PASSWORD_SECRET = null;

// Channel bot tokens — fetched from Secrets Manager eagerly at boot.
// Used by channel-sender.js to deliver responses directly from the container.
let TELEGRAM_BOT_TOKEN = null;
let SLACK_BOT_TOKEN = null;

// Maximum request body size (1MB) to prevent memory exhaustion
const MAX_BODY_SIZE = 1 * 1024 * 1024;

// State tracking
let currentUserId = null;
let currentNamespace = null;
let openclawProcess = null;
let proxyProcess = null;
let openclawReady = false;
let proxyReady = false;
let secretsReady = false;
let initInProgress = false;
let initPromise = null;
let secretsPrefetchPromise = null;
let currentChannel = null;
let currentChatId = null;
let startTime = Date.now();
let shuttingDown = false;
let credentialRefreshTimer = null;
const SCOPED_CREDS_DIR = "/tmp/scoped-creds";
const BUILD_VERSION = "v32"; // Bump in cdk.json to force container redeploy

// OpenClaw process diagnostics (last N lines of stdout/stderr)
const OPENCLAW_LOG_LIMIT = 50;
let openclawLogs = [];
let openclawExitCode = null;

// Message queue for serializing concurrent requests (OpenClaw WebSocket path)
let messageQueue = [];
let processingMessage = false;

// Dedup: runIds handled by the per-message bridge (persistent listener skips these)
const bridgeHandledRunIds = new Map(); // runId → timestamp
const BRIDGE_RUNID_TTL_MS = 10 * 60 * 1000; // 10 minutes

function markBridgeHandledRunId(runId) {
  if (!runId) return;
  bridgeHandledRunIds.set(runId, Date.now());
  // Prune old entries
  const cutoff = Date.now() - BRIDGE_RUNID_TTL_MS;
  for (const [id, ts] of bridgeHandledRunIds) {
    if (ts < cutoff) bridgeHandledRunIds.delete(id);
    else break; // Map preserves insertion order
  }
}

/**
 * Pre-fetch secrets from Secrets Manager at container boot.
 * Runs in the background — does not block /ping health checks.
 */
async function prefetchSecrets() {
  const region = process.env.AWS_REGION || "us-west-2";
  const smClient = new SecretsManagerClient({ region });

  const gatewaySecretId = process.env.GATEWAY_TOKEN_SECRET_ID;
  if (gatewaySecretId) {
    const resp = await smClient.send(
      new GetSecretValueCommand({ SecretId: gatewaySecretId }),
    );
    if (resp.SecretString) {
      GATEWAY_TOKEN = resp.SecretString;
      console.log("[contract] Gateway token pre-fetched from Secrets Manager");
    }
  }

  const cognitoSecretId = process.env.COGNITO_PASSWORD_SECRET_ID;
  if (cognitoSecretId) {
    const resp = await smClient.send(
      new GetSecretValueCommand({ SecretId: cognitoSecretId }),
    );
    if (resp.SecretString) {
      COGNITO_PASSWORD_SECRET = resp.SecretString;
      console.log("[contract] Cognito password secret pre-fetched");
    }
  }

  // Fetch channel bot tokens (for async direct response mode)
  const telegramSecretId = process.env.TELEGRAM_TOKEN_SECRET_ID;
  if (telegramSecretId) {
    try {
      const resp = await smClient.send(
        new GetSecretValueCommand({ SecretId: telegramSecretId }),
      );
      if (resp.SecretString) {
        TELEGRAM_BOT_TOKEN = resp.SecretString;
        console.log("[contract] Telegram bot token pre-fetched");
      }
    } catch (err) {
      console.warn(`[contract] Telegram token fetch failed: ${err.message}`);
    }
  }

  const slackSecretId = process.env.SLACK_TOKEN_SECRET_ID;
  if (slackSecretId) {
    try {
      const resp = await smClient.send(
        new GetSecretValueCommand({ SecretId: slackSecretId }),
      );
      if (resp.SecretString) {
        // Slack secret is JSON: {"botToken":"xoxb-...","signingSecret":"..."}
        try {
          const data = JSON.parse(resp.SecretString);
          SLACK_BOT_TOKEN = data.botToken || resp.SecretString;
        } catch {
          SLACK_BOT_TOKEN = resp.SecretString;
        }
        console.log("[contract] Slack bot token pre-fetched");
      }
    } catch (err) {
      console.warn(`[contract] Slack token fetch failed: ${err.message}`);
    }
  }

  secretsReady = true;
  console.log("[contract] Secrets pre-fetch complete");
}

/**
 * Clean up stale .lock files in the .openclaw directory (async, non-blocking).
 * Prevents "session file locked" errors after workspace restore from S3.
 */
async function cleanupLockFiles() {
  const fs = require("fs");
  const path = require("path");
  const homeDir = process.env.HOME || "/root";
  const openclawDir = path.join(homeDir, ".openclaw");

  try {
    await fs.promises.access(openclawDir);
  } catch {
    return; // Directory doesn't exist yet — nothing to clean
  }

  async function walkAndClean(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const tasks = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        tasks.push(walkAndClean(fullPath));
      } else if (entry.name.endsWith(".lock")) {
        tasks.push(
          fs.promises.unlink(fullPath).catch(() => {}),
        );
      }
    }
    await Promise.all(tasks);
  }

  await walkAndClean(openclawDir);
  console.log("[contract] Lock file cleanup complete (async)");
}

/**
 * Check if the proxy health endpoint responds.
 */
function checkProxyHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PROXY_PORT}/health`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Send a lightweight request to the proxy to trigger JIT compilation
 * of the request handling path. Makes the first real user message faster.
 */
function warmProxyJit() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: "bedrock-agentcore",
      messages: [{ role: "user", content: "warmup" }],
      max_tokens: 1,
      stream: false,
    });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PROXY_PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          console.log("[contract] Proxy JIT warm-up complete");
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Check if OpenClaw gateway port is listening.
 */
function checkOpenClawReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${OPENCLAW_PORT}`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for a port to become available, with timeout.
 */
async function waitForPort(port, label, timeoutMs = 300000, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) {
      console.log(`[contract] ${label} is ready on port ${port}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.error(
    `[contract] ${label} did not become ready within ${timeoutMs / 1000}s`,
  );
  return false;
}

/**
 * Write a headless OpenClaw config (no channels — messages bridged via WebSocket).
 * Config generated by shared openclaw-config.js — single source of truth validated
 * by config-validation.test.js before every deployment.
 */
function writeOpenClawConfig() {
  const fs = require("fs");
  const config = generateOpenClawConfig({ gatewayToken: GATEWAY_TOKEN });

  const homeDir = process.env.HOME || "/root";
  fs.mkdirSync(`${homeDir}/.openclaw`, { recursive: true });
  fs.writeFileSync(
    `${homeDir}/.openclaw/openclaw.json`,
    JSON.stringify(config, null, 2),
  );
  console.log("[contract] OpenClaw headless config written");
}

// AGENTS.md content — canonical operating instructions for the AI agent.
// Written to S3 at {namespace}/AGENTS.md on every init so the proxy's system
// prompt injection always has the latest instructions.
const AGENTS_MD_CONTENT = [
  "# Agent Instructions",
  "",
  "You are a helpful AI assistant running in a per-user container on AWS.",
  "You have built-in web tools, file storage, scheduling, and many community skills.",
  "",
  "## User-Facing Communication Rules",
  "",
  "**NEVER expose internal implementation details to the user.** They are a regular end-user, not a developer.",
  "Never mention: context windows, token limits, tool parameters, tool names, retry logic, S3 buckets,",
  "API errors, exec failures, argument overflow, [SEND_FILE] markers, or any internal mechanism.",
  "If a tool fails, retry silently or apologize briefly ('Let me try a different approach') without technical details.",
  "Never say things like 'the exec tool failed' or 'context window is running low'.",
  "",
  "## Built-in Web Tools",
  "",
  "You have built-in **web_search** and **web_fetch** tools:",
  "- **web_search**: Search the web for current information",
  "- **web_fetch**: Fetch and read web page content as markdown",
  "",
  "Use these for real-time information, news, research, and reading web pages.",
  "",
  "## Scheduling & Cron Jobs",
  "",
  "You have the **eventbridge-cron** skill for scheduling tasks. When users ask to:",
  "- Set up reminders, alarms, or scheduled messages",
  "- Create recurring tasks or cron jobs",
  "- Schedule daily, weekly, or periodic actions",
  "",
  "**Read the eventbridge-cron SKILL.md and use it.** Do NOT say cron is disabled.",
  "The built-in cron is replaced by Amazon EventBridge Scheduler (more reliable, persists across sessions).",
  "",
  "Always ask the user for their **timezone** if you don't know it (e.g., Asia/Shanghai, America/New_York).",
  "",
  "## Memory Persistence (IMPORTANT)",
  "",
  "Your conversation history does NOT survive across sessions. To remember things permanently,",
  "you MUST save them to files using the s3-user-files skill. Check these files at the START of every conversation:",
  "",
  "- **USER.md**: User preferences — timezone, language, name, interests, communication style.",
  "  When the user tells you their timezone, name, preferences, or any personal info, IMMEDIATELY",
  "  update USER.md with `write_user_file USER.md --file=/tmp/USER.md`.",
  "- **MEMORY.md**: Things the user explicitly asks you to remember ('remember that...', 'note that...').",
  "  Always save these immediately — don't just acknowledge, actually write to MEMORY.md.",
  "",
  "At the start of each conversation, read USER.md and MEMORY.md to restore context.",
  "If they exist, greet the user by name and reference known preferences.",
  "",
  "## File Storage",
  "",
  "You have the **s3-user-files** skill for persistent file storage. Files survive across sessions.",
  "",
  "### CRITICAL: Sharing files with users",
  "",
  "**NEVER share local filesystem paths** (like `/root/...` or `/tmp/...`) with users — they are meaningless outside the container.",
  "",
  "**NEVER generate or share presigned S3 URLs** (`aws s3 presign`), S3 URIs (`s3://...`), download links, or ANY URL pointing to a file.",
  "URLs do not work — users cannot access S3 directly. The ONLY way to deliver files is `[SEND_FILE:filename]`.",
  "",
  "File delivery workflow:",
  "1. Create file locally at /tmp/ (see methods below)",
  "2. Upload: `write_user_file filename --file=/tmp/filename`",
  "3. Deliver: include `[SEND_FILE:filename]` in your response",
  "",
  "The `[SEND_FILE:filename]` marker delivers the file as a native attachment in Telegram/Slack.",
  "",
  "### CRITICAL: Writing large content to files",
  "",
  "**Never pass large content as bash command arguments** — it will overflow tool argument limits.",
  "Always use bash heredoc to write to /tmp, then upload with --file=:",
  "```bash",
  "cat > /tmp/output.html << 'FILEEOF'",
  "<!DOCTYPE html>",
  "<html><body><h1>Title</h1><p>Content here...</p></body></html>",
  "FILEEOF",
  "```",
  "Then: `write_user_file output.html --file=/tmp/output.html`",
  "",
  "This works for ANY text file: HTML, CSV, JSON, XML, markdown, code, etc.",
  "",
  "### Pre-installed Python libraries for file generation",
  "",
  "| Library | Use for |",
  "|---|---|",
  "| `xhtml2pdf` + `markdown` | PDF from markdown (MD→HTML→PDF) |",
  "| `matplotlib` | Charts, graphs, plots (PNG/SVG) |",
  "| `pillow` (PIL) | Image creation and manipulation |",
  "| `qrcode` | QR code generation |",
  "| `icalendar` | Calendar event files (.ics) |",
  "| `fpdf2` | Simple PDFs (avoid for complex content) |",
  "",
  "### PDF generation (markdown → HTML → PDF):",
  "",
  "1. Write markdown to /tmp/content.md using bash heredoc",
  "2. Write and run this converter:",
  "```python",
  "import markdown; from xhtml2pdf import pisa",
  "with open('/tmp/content.md') as f: md = f.read()",
  "css = 'body{font-family:Helvetica,sans-serif;font-size:11px;line-height:1.5;margin:40px} h1{color:#333;border-bottom:2px solid #333} h2{color:#555} a{color:#0066cc} pre{background:#f4f4f4;padding:10px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;padding:6px;text-align:left} th{background:#f0f0f0}'",
  "html = f'<html><head><style>{css}</style></head><body>' + markdown.markdown(md, extensions=['tables','fenced_code']) + '</body></html>'",
  "with open('/tmp/report.pdf','wb') as f: pisa.CreatePDF(html, dest=f)",
  "```",
  "",
  "### Charts and images:",
  "```python",
  "import matplotlib; matplotlib.use('Agg')",
  "import matplotlib.pyplot as plt",
  "plt.figure(figsize=(8,5)); plt.plot([1,2,3],[4,5,6]); plt.savefig('/tmp/chart.png', dpi=150, bbox_inches='tight')",
  "```",
  "Then: `write_user_file chart.png --file=/tmp/chart.png` + `[SEND_FILE:chart.png]`",
  "",
  "## Web Scraping (Scrapling)",
  "",
  "You have **Scrapling** installed — a Python web scraping framework with TLS fingerprint impersonation.",
  "Use it when `web_fetch` fails on protected websites (Cloudflare, cookie walls, JS-heavy sites).",
  "",
  "```python",
  "from scrapling.fetchers import Fetcher",
  "page = Fetcher.get('https://example.com', impersonate='chrome')",
  "items = page.css('.item').getall()  # CSS selectors like Scrapy",
  "texts = page.css('.title::text').getall()  # Extract text",
  "```",
  "",
  "**Works on**: Fotocasa, pisos.com, and most sites with JS rendering / cookie walls.",
  "**Does NOT work on**: Idealista (DataDome CAPTCHA), Milanuncios (CAPTCHA).",
  "",
  "Use `impersonate='chrome'` to mimic Chrome's TLS fingerprint and bypass basic anti-bot checks.",
  "",
  "## Community Skills (ClawHub)",
  "",
  "The following community skills are pre-installed:",
  "- **jina-reader**: Extract web content as clean markdown (higher quality than built-in web_fetch)",
  "- **deep-research-pro**: In-depth multi-step research on complex topics (uses sub-agents)",
  "- **telegram-compose**: Rich HTML formatting for Telegram messages",
  "- **transcript**: YouTube video transcript extraction",
  "- **task-decomposer**: Break complex requests into manageable subtasks (uses sub-agents)",
  "",
  "## Task Delegation (CRITICAL)",
  "",
  "You are a FAST ROUTER. Your job is to respond to the user IMMEDIATELY and delegate complex work to sub-agents.",
  "",
  "### Rules:",
  "1. ALWAYS acknowledge the user's request within seconds",
  "2. For simple questions/chat → answer directly (no sub-agent needed)",
  "3. For complex tasks → tell the user you're starting the work, then use task-decomposer or deep-research-pro to delegate",
  "",
  "### What to delegate:",
  "- Web scraping (multiple pages, data extraction)",
  "- File generation (PDFs, charts, Excel files, code projects)",
  "- Multi-step research (market analysis, comparisons, deep dives)",
  "- Data processing (reading files, transforming data, analysis)",
  "- Any task that involves 3+ tool calls",
  "",
  "### What to handle directly:",
  "- Greetings, simple questions, conversation",
  "- Single web_fetch or web_search",
  "- Quick lookups (weather, time, simple facts)",
  "- Reading/writing memory files (USER.md, MEMORY.md)",
  "- Creating/managing cron schedules",
  "",
  "### Delegation pattern:",
  "User: \"Analyze my portfolio and create a report\"",
  "You: \"On it! Starting the analysis now — I'll send you the report when it's ready. Feel free to ask me anything else while I work.\"",
  "→ Then immediately use task-decomposer to break into subtasks",
  "→ Sub-agents handle the heavy lifting in the background (up to 1 hour, 200 tool calls each)",
  "→ Results are delivered when ready",
  "",
  "### Sub-agent details:",
  "- task-decomposer: breaks complex requests into parallel subtasks",
  "- deep-research-pro: in-depth multi-step research on a topic",
  "- Sub-agents share your tools and capabilities. Sandbox is disabled (the container is already isolated)",
  "- Up to 2 sub-agents run concurrently",
  "",
].join("\n");

/**
 * Write AGENTS.md to S3 at {namespace}/AGENTS.md (top-level).
 * The proxy reads from this path to inject instructions into the system prompt.
 * Uses workspace-sync's S3 client which has scoped credentials configured.
 */
async function writeAgentsMdToS3(namespace) {
  const bucket = process.env.S3_USER_FILES_BUCKET;
  if (!bucket || !namespace) {
    console.log("[contract] No bucket or namespace — skipping AGENTS.md S3 write");
    return;
  }
  try {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = workspaceSync.getS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${namespace}/AGENTS.md`,
        Body: AGENTS_MD_CONTENT,
        ContentType: "text/markdown; charset=utf-8",
      }),
    );
    console.log(`[contract] AGENTS.md written to s3://${bucket}/${namespace}/AGENTS.md`);
  } catch (err) {
    console.warn(`[contract] Failed to write AGENTS.md to S3: ${err.message}`);
  }
}

/**
 * Pre-approve the OpenClaw device identity in the pairing store.
 *
 * sessions_spawn creates a GatewayClient that includes a device identity
 * (from ~/.openclaw/identity/device.json). The gateway requires new devices
 * to be "paired" (approved). In a headless container there's no UI to approve,
 * so we pre-populate ~/.openclaw/devices/paired.json with the device identity.
 */
async function preApproveDevicePairing() {
  const fs = require("fs");
  const path = require("path");
  const homeDir = process.env.HOME || "/root";
  const identityPath = path.join(homeDir, ".openclaw", "identity", "device.json");
  const pairedPath = path.join(homeDir, ".openclaw", "devices", "paired.json");

  if (!fs.existsSync(identityPath)) {
    console.log("[contract] No device identity found — skipping pairing pre-approval");
    return;
  }

  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  const deviceId = identity.deviceId;
  const publicKeyPem = identity.publicKeyPem;
  if (!deviceId || !publicKeyPem) {
    console.warn("[contract] Invalid device identity — skipping pairing pre-approval");
    return;
  }

  // Derive the public key fingerprint (same as OpenClaw uses for pairing)
  const crypto = require("crypto");
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const spki = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI has a 12-byte prefix; raw key is the last 32 bytes
  const rawKey = spki.length === 44 ? spki.subarray(12) : spki;
  const publicKeyRaw = rawKey.toString("base64url");

  // Check if already paired
  let existingPaired = {};
  if (fs.existsSync(pairedPath)) {
    try {
      existingPaired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
    } catch {}
  }
  if (existingPaired[deviceId]) {
    console.log(`[contract] Device ${deviceId.slice(0, 12)}… already paired`);
    return;
  }

  // Create paired device entry
  const now = Date.now();
  existingPaired[deviceId] = {
    deviceId,
    publicKey: publicKeyRaw,
    displayName: "agentcore-container",
    platform: "linux",
    clientId: "gateway-client",
    clientMode: "backend",
    role: "operator",
    roles: ["operator"],
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
    approvedScopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
    createdAtMs: now,
    approvedAtMs: now,
  };

  fs.mkdirSync(path.dirname(pairedPath), { recursive: true });
  fs.writeFileSync(pairedPath, JSON.stringify(existingPaired, null, 2));
  console.log(`[contract] Device ${deviceId.slice(0, 12)}… pre-approved for sub-agent pairing`);
}

/**
 * Persistent WS listener for sub-agent follow-up delivery.
 *
 * Maintains a long-lived WS connection to the OpenClaw gateway and listens
 * for ALL chat events. When a sub-agent completes, OpenClaw's announce system
 * injects the result as a new agent turn, producing chat events that the
 * per-message bridge (already closed) would miss. This listener catches them
 * and delivers to Telegram/Slack.
 *
 * Supports multiple parallel sub-agents completing at different times.
 */
let persistentWs = null;
let persistentWsReconnectTimer = null;
let persistentWsReconnectDelay = 5000;
const PERSISTENT_WS_MAX_RECONNECT_DELAY = 60000;
const PERSISTENT_DRAFT_THROTTLE_MS = 300;

function startPersistentChatListener() {
  if (persistentWs) return; // Already running
  if (!GATEWAY_TOKEN) {
    console.warn("[listener] No gateway token — skipping persistent listener");
    return;
  }

  const url = `ws://127.0.0.1:${OPENCLAW_PORT}`;
  console.log("[listener] Connecting persistent chat listener...");
  const ws = new WebSocket(url);
  persistentWs = ws;

  let authenticated = false;
  const connectId = `listener-${Date.now()}`;
  // Track streaming state per runId for follow-up drafts
  const followUpDrafts = new Map(); // runId → { draftId, lastDraftTime }

  ws.on("open", () => {
    console.log("[listener] WS connected, authenticating...");
    ws.send(
      JSON.stringify({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            // Use "gateway-client" (not "openclaw-control-ui") to avoid origin check.
            // ControlUI clients always trigger origin validation which fails for
            // non-browser WS connections (no Origin header).
            id: "gateway-client",
            mode: "backend",
            version: "listener",
            platform: "linux",
          },
          caps: [],
          auth: { token: GATEWAY_TOKEN },
          role: "operator",
          scopes: ["operator.read"],
        },
      }),
    );
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Auth response
    if (msg.type === "res" && msg.id === connectId) {
      if (!msg.ok) {
        console.error(`[listener] Auth failed: ${JSON.stringify(msg.error || msg.payload)}`);
        ws.close();
        return;
      }
      authenticated = true;
      persistentWsReconnectDelay = 5000; // Reset backoff on success
      console.log("[listener] Persistent chat listener authenticated and listening");
      return;
    }

    if (!authenticated) return;

    // Only care about chat events
    if (msg.type !== "event" || msg.event !== "chat") return;

    const payload = msg.payload || {};
    const runId = payload.runId || payload.run?.runId;

    // Skip events from runs already handled by the per-message bridge
    if (runId && bridgeHandledRunIds.has(runId)) return;

    // Need channel context to deliver
    if (!currentChatId || !currentChannel) return;

    const isTelegram = currentChannel === "telegram";

    if (payload.state === "delta") {
      // Streaming follow-up — send Telegram drafts
      if (!isTelegram) return;
      if (!TELEGRAM_BOT_TOKEN) return;

      const text = extractTextFromContent(
        payload.message?.content || payload.message || payload.text || payload.content,
      );
      if (!text) return;

      // Clean content blocks for streaming
      const cleanText = channelSender.extractTextFromContentBlocks(text);
      if (!cleanText || cleanText.length < 20) return;

      // Get or create draft state for this runId
      const draftKey = runId || "unknown";
      if (!followUpDrafts.has(draftKey)) {
        followUpDrafts.set(draftKey, {
          draftId: String(Date.now() * 1000000 + Math.floor(Math.random() * 1000000)),
          lastDraftTime: 0,
        });
      }
      const draft = followUpDrafts.get(draftKey);
      const now = Date.now();
      if (now - draft.lastDraftTime < PERSISTENT_DRAFT_THROTTLE_MS) return;
      draft.lastDraftTime = now;

      channelSender.sendTelegramDraft(currentChatId, cleanText, TELEGRAM_BOT_TOKEN, draft.draftId);
      return;
    }

    if (payload.state === "final") {
      const text = extractTextFromContent(
        payload.message?.content || payload.message || payload.text || payload.content,
      );
      if (!text || !text.trim()) return;

      // Clean up draft state for this run
      const draftKey = runId || "unknown";
      followUpDrafts.delete(draftKey);

      console.log(
        `[listener] Follow-up chat final (${text.length} chars, runId=${(runId || "?").slice(0, 20)}…)`,
      );

      // Deliver to channel
      channelSender
        .deliverResponse(
          currentChannel,
          currentChatId,
          text,
          [], // no files
          { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN },
        )
        .catch((err) => {
          console.error(`[listener] Follow-up delivery failed: ${err.message}`);
        });
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[listener] WS closed: code=${code} reason=${reason?.toString() || ""}`);
    persistentWs = null;
    if (!shuttingDown) {
      console.log(`[listener] Reconnecting in ${persistentWsReconnectDelay}ms...`);
      persistentWsReconnectTimer = setTimeout(() => {
        persistentWsReconnectDelay = Math.min(
          persistentWsReconnectDelay * 2,
          PERSISTENT_WS_MAX_RECONNECT_DELAY,
        );
        startPersistentChatListener();
      }, persistentWsReconnectDelay);
    }
  });

  ws.on("error", (err) => {
    console.error(`[listener] WS error: ${err.message}`);
    // close event will fire and trigger reconnect
  });
}

/**
 * Poll for OpenClaw readiness in the background.
 * Sets openclawReady=true and starts workspace saves when ready.
 */
async function pollOpenClawReadiness(namespace) {
  const ready = await waitForPort(OPENCLAW_PORT, "OpenClaw", 300000, 5000);
  if (ready) {
    openclawReady = true;
    workspaceSync.startPeriodicSave(namespace);
    console.log(
      "[contract] OpenClaw ready — switching from lightweight agent to full OpenClaw",
    );
    // Pre-approve device identity for sub-agent pairing.
    // sessions_spawn creates a GatewayClient with the device identity from
    // ~/.openclaw/identity/device.json. The gateway requires pairing approval
    // for new devices. We pre-populate the pairing store so sub-agents connect
    // without interactive approval (no UI in headless container).
    preApproveDevicePairing().catch((err) => {
      console.warn(`[contract] Device pairing pre-approval failed: ${err.message}`);
    });
    // Start persistent listener for sub-agent follow-up delivery
    startPersistentChatListener();
  } else {
    console.error(
      "[contract] OpenClaw failed to start — lightweight agent will continue handling messages",
    );
  }
}

/**
 * Initialization — called on first /invocations request.
 *
 * Uses pre-fetched secrets. Starts proxy, OpenClaw, and workspace restore
 * in parallel. Only waits for proxy readiness (~5s), then returns.
 * OpenClaw readiness is polled in the background.
 */
async function init(userId, actorId, channel) {
  if (proxyReady) return; // Already initialized
  if (initInProgress) return initPromise;
  initInProgress = true;

  initPromise = (async () => {
    const namespace = actorId.replace(/:/g, "_");
    currentUserId = userId;
    currentNamespace = namespace;

    console.log(
      `[contract] Init for user=${userId} actor=${actorId} namespace=${namespace}`,
    );

    // 0. Wait for pre-fetched secrets (should already be done by now)
    if (!secretsReady && secretsPrefetchPromise) {
      console.log("[contract] Waiting for secrets pre-fetch to complete...");
      await secretsPrefetchPromise;
    }

    // Retry secrets fetch inline if pre-fetch failed (transient error recovery)
    if (!GATEWAY_TOKEN) {
      console.log(
        "[contract] Gateway token missing — retrying secrets fetch...",
      );
      await prefetchSecrets();
    }
    if (!GATEWAY_TOKEN) {
      throw new Error(
        "Gateway token not available — cannot authenticate WebSocket connections",
      );
    }

    // 1b. Create scoped S3 credentials (per-user IAM isolation)
    // Restricts S3 access to the user's namespace prefix, preventing cross-user
    // data access even through OpenClaw's bash/code execution tools.
    let scopedCredsAvailable = false;
    if (process.env.EXECUTION_ROLE_ARN) {
      try {
        console.log(`[contract] Creating scoped S3 credentials for namespace=${namespace}...`);
        const creds = await scopedCreds.createScopedCredentials(namespace);
        scopedCreds.writeCredentialFiles(creds, SCOPED_CREDS_DIR);
        workspaceSync.configureCredentials(creds);
        scopedCredsAvailable = true;
        console.log("[contract] Scoped S3 credentials created and applied");

        // Refresh credentials before expiry (45 min timer, max 1 hour session)
        if (credentialRefreshTimer) clearInterval(credentialRefreshTimer);
        credentialRefreshTimer = setInterval(async () => {
          try {
            console.log("[contract] Refreshing scoped S3 credentials...");
            const refreshed = await scopedCreds.createScopedCredentials(namespace);
            scopedCreds.writeCredentialFiles(refreshed, SCOPED_CREDS_DIR);
            workspaceSync.configureCredentials(refreshed);
            console.log("[contract] Scoped S3 credentials refreshed");
          } catch (err) {
            console.error(`[contract] Credential refresh failed: ${err.message}`);
          }
        }, 45 * 60 * 1000); // 45 minutes
      } catch (err) {
        console.warn(`[contract] Scoped credentials failed (falling back to full role): ${err.message}`);
        // Non-fatal — fall back to full execution role credentials
      }
    } else {
      console.log("[contract] EXECUTION_ROLE_ARN not set — skipping credential scoping");
    }

    // 1c. Clean up stale lock files restored from S3 (non-blocking)
    // Runs in parallel with proxy startup — does not block init.
    const lockCleanupPromise = cleanupLockFiles().catch((err) => {
      console.warn(`[contract] Lock cleanup failed: ${err.message}`);
    });

    // 2. Start the Bedrock proxy with user identity env vars
    // Only pass required env vars — avoid leaking secrets via process.env spread
    console.log("[contract] Starting Bedrock proxy...");
    const proxyEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME || "/root",
      NODE_PATH: process.env.NODE_PATH || "/app/node_modules",
      NODE_OPTIONS: process.env.NODE_OPTIONS || "",
      AWS_REGION: process.env.AWS_REGION || "us-west-2",
      BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID || "",
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID || "",
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID || "",
      COGNITO_PASSWORD_SECRET: COGNITO_PASSWORD_SECRET || "",
      S3_USER_FILES_BUCKET: process.env.S3_USER_FILES_BUCKET || "",
      SUBAGENT_MODEL_NAME: SUBAGENT_MODEL_NAME,
      SUBAGENT_BEDROCK_MODEL_ID: process.env.SUBAGENT_BEDROCK_MODEL_ID || "",
      USER_ID: actorId,
      CHANNEL: channel,
      OPENCLAW_SKIP_CRON: "1", // Disable internal cron — EventBridge handles scheduling
    };
    proxyProcess = spawn("node", ["/app/agentcore-proxy.js"], {
      env: proxyEnv,
      stdio: "inherit",
    });
    proxyProcess.on("exit", (code) => {
      console.log(`[contract] Proxy exited with code ${code}`);
      proxyReady = false;
    });

    // Wait for lock cleanup to complete before starting OpenClaw
    await lockCleanupPromise;

    // Write OpenClaw config and start gateway (non-blocking)
    writeOpenClawConfig();
    console.log("[contract] Starting OpenClaw gateway (headless)...");
    // Build scoped env for OpenClaw — excludes container credentials,
    // uses credential_process for scoped S3 access only.
    // Falls back to full process.env if scoped credentials failed.
    const openclawBaseEnv = scopedCredsAvailable
      ? scopedCreds.buildOpenClawEnv({
          credDir: SCOPED_CREDS_DIR,
          baseEnv: process.env,
        })
      : { ...process.env, OPENCLAW_SKIP_CRON: "1" };
    // Sub-agents inherit env vars and need the gateway token to authenticate
    // their WS connection back to the gateway. Without this, sessions_spawn
    // fails with "pairing required" (gateway closes with code 1008).
    const openclawEnv = {
      ...openclawBaseEnv,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    };
    openclawProcess = spawn(
      "openclaw",
      ["gateway", "run", "--port", String(OPENCLAW_PORT), "--verbose"],
      { stdio: ["ignore", "pipe", "pipe"], env: openclawEnv },
    );
    // Capture OpenClaw stdout/stderr for diagnostics
    const captureLog = (stream, label) => {
      let buf = "";
      stream.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) {
          if (line.trim()) {
            console.log(`[openclaw:${label}] ${line}`);
            openclawLogs.push(`[${label}] ${line}`);
            if (openclawLogs.length > OPENCLAW_LOG_LIMIT) openclawLogs.shift();
          }
        }
      });
    };
    captureLog(openclawProcess.stdout, "out");
    captureLog(openclawProcess.stderr, "err");
    openclawProcess.on("exit", (code) => {
      console.log(`[contract] OpenClaw exited with code ${code}`);
      openclawExitCode = code;
      openclawReady = false;
    });

    // Restore workspace from S3 (non-blocking, needed for OpenClaw)
    workspaceSync.restoreWorkspace(namespace).catch((err) => {
      console.warn(`[contract] Workspace restore failed: ${err.message}`);
    });

    // Write AGENTS.md to S3 at {namespace}/AGENTS.md (top-level, where the proxy reads it).
    // This ensures the proxy's system prompt injection has the full operating instructions
    // from the very first request. Always overwrite to pick up latest instructions on redeploy.
    writeAgentsMdToS3(namespace).catch((err) => {
      console.warn(`[contract] AGENTS.md S3 write failed: ${err.message}`);
    });

    // 2. Wait only for proxy readiness (~5s)
    proxyReady = await waitForPort(PROXY_PORT, "Proxy", 30000, 1000);
    if (!proxyReady) {
      throw new Error("Proxy failed to start within 30s");
    }

    // 2b. Warm proxy JIT — send a lightweight request to trigger V8 compilation
    // of the request handling path, so the first real user message is faster.
    warmProxyJit().catch(() => {}); // non-blocking, fire-and-forget

    // 3. Poll for OpenClaw readiness in the background (don't block)
    pollOpenClawReadiness(namespace).catch((err) => {
      console.error(
        `[contract] OpenClaw readiness polling failed: ${err.message}`,
      );
    });

    console.log(
      "[contract] Init complete — proxy ready, lightweight agent active",
    );
  })();

  try {
    await initPromise;
  } catch (err) {
    // Reset initPromise on failure so concurrent requests don't await a stale rejected promise
    initPromise = null;
    throw err;
  } finally {
    initInProgress = false;
  }
}

/**
 * Extract plain text from message content — handles string, array of content
 * blocks, JSON-serialized array of content blocks, or object with text/content.
 *
 * Recursively unwraps nested content blocks (common with subagent responses
 * where each layer wraps the previous one in content block JSON).
 */
function extractTextFromContent(content) {
  if (!content) return "";
  // Already a parsed array of content blocks
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    // Recurse in case the inner text is itself a JSON content block array
    return extractTextFromContent(text);
  }
  if (typeof content === "string") {
    // Check if the string is a JSON-serialized array of content blocks
    const trimmed = content.trim();
    if (trimmed.startsWith("[{") && trimmed.endsWith("]")) {
      // Sanitize control characters (literal newlines, tabs) that are invalid
      // in JSON strings but may appear in OpenClaw bridge responses.
      const sanitized = trimmed.replace(/[\x00-\x1f]/g, (ch) => {
        if (ch === "\n") return "\\n";
        if (ch === "\r") return "\\r";
        if (ch === "\t") return "\\t";
        return "";
      });
      try {
        const parsed = JSON.parse(sanitized);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed[0].type === "text"
        ) {
          const text = parsed
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          // Recurse to unwrap further nesting
          return extractTextFromContent(text);
        }
      } catch {}
      // Regex fallback: strip [{"type":"text","text":"..."}] wrapper (complete or partial)
      // During streaming, deltas may be incomplete JSON — strip the prefix anyway.
      const prefixMatch = trimmed.match(
        /^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/,
      );
      if (prefixMatch) {
        let inner = trimmed.slice(prefixMatch[0].length);
        // Strip closing "}] if present (complete content block)
        if (inner.endsWith('"}]')) inner = inner.slice(0, -3);
        const unescaped = inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        return extractTextFromContent(unescaped);
      }
    }
    // Plain text string
    return content;
  }
  // Object with text or content property (e.g., {role: "assistant", content: "..."})
  if (typeof content === "object" && content !== null) {
    if (typeof content.text === "string")
      return extractTextFromContent(content.text);
    if (typeof content.content === "string")
      return extractTextFromContent(content.content);
    if (Array.isArray(content.content)) {
      const text = content.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return extractTextFromContent(text);
    }
  }
  return "";
}

/**
 * Process the message queue serially to prevent concurrent WebSocket race conditions.
 */
async function processMessageQueue() {
  if (processingMessage || messageQueue.length === 0) return;
  processingMessage = true;

  while (messageQueue.length > 0) {
    const { message, resolve, reject, onDelta } = messageQueue.shift();
    console.log(
      `[contract] Processing queued message (${messageQueue.length} remaining)`,
    );

    try {
      const response = await bridgeMessage(message, 560000, onDelta);
      resolve(response);
    } catch (err) {
      reject(err);
    }
  }

  processingMessage = false;
}

/**
 * Enqueue a message and wait for its response (serialized processing).
 * Optional onDelta callback is invoked with accumulated text on each streaming delta.
 */
function enqueueMessage(message, onDelta = null) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ message, resolve, reject, onDelta });
    console.log(
      `[contract] Message enqueued (queue length: ${messageQueue.length})`,
    );
    processMessageQueue().catch((err) => {
      console.error(`[contract] Queue processing error: ${err.message}`);
    });
  });
}

/**
 * Bridge a chat message to OpenClaw via WebSocket and collect the response.
 */
async function bridgeMessage(message, timeoutMs = 560000, onDelta = null) {
  const { randomUUID } = require("crypto");
  return new Promise((resolve) => {
    const wsUrl = `ws://127.0.0.1:${OPENCLAW_PORT}`;
    console.log(`[contract] Connecting to WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: `http://127.0.0.1:${OPENCLAW_PORT}` },
    });
    let responseText = "";
    let authenticated = false;
    let chatSent = false;
    let resolved = false;
    let connectReqId = null;
    let chatReqId = null;
    let unhandledMsgs = [];

    const done = (text) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(text);
    };

    const timer = setTimeout(() => {
      const debugInfo =
        unhandledMsgs.length > 0
          ? ` unhandled=[${unhandledMsgs.slice(0, 5).join(" | ")}]`
          : "";
      console.warn(
        `[contract] WebSocket timeout after ${timeoutMs}ms (auth=${authenticated}, chatSent=${chatSent}, responseLen=${responseText.length})${debugInfo}`,
      );
      // Return "" on timeout so caller can fall back to lightweight agent
      done(responseText || "");
    }, timeoutMs);

    ws.on("open", () => {
      console.log("[contract] WebSocket connected, waiting for challenge...");
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      console.log(`[contract] WS rx: ${raw.slice(0, 500)}`);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        console.log(`[contract] WS parse error: ${e.message}`);
        return;
      }

      // Step 1: Server sends connect.challenge event -> client sends connect request
      if (msg.type === "event" && msg.event === "connect.challenge") {
        console.log(
          "[contract] Received challenge, sending connect request...",
        );
        connectReqId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectReqId,
            method: "connect",
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "openclaw-control-ui",
                mode: "backend",
                version: "dev",
                platform: "linux",
              },
              caps: [],
              auth: { token: GATEWAY_TOKEN },
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
          }),
        );
        return;
      }

      // Step 2: Server responds to connect request -> send chat.send
      if (msg.type === "res" && msg.id === connectReqId) {
        if (!msg.ok) {
          console.error(
            `[contract] Connect rejected: ${JSON.stringify(msg.error || msg.payload)}`,
          );
          done(
            `Auth failed: ${msg.error?.message || JSON.stringify(msg.payload)}`,
          );
          return;
        }
        authenticated = true;
        console.log(
          "[contract] Authenticated successfully, sending chat.send...",
        );
        chatReqId = randomUUID();
        ws.send(
          JSON.stringify({
            type: "req",
            id: chatReqId,
            method: "chat.send",
            params: {
              sessionKey: "global",
              message: message,
              idempotencyKey: chatReqId,
            },
          }),
        );
        chatSent = true;
        return;
      }

      // Helper: try all known content locations in a payload
      const extractFromPayload = (pl) => {
        return (
          extractTextFromContent(pl.message?.content) ||
          extractTextFromContent(pl.message) ||
          extractTextFromContent(pl.text) ||
          extractTextFromContent(pl.content)
        );
      };

      // Step 3: Chat events — state: "delta" (streaming) or "final" (complete)
      // OpenClaw puts content in payload.message.content (usual) or
      // directly in payload.message (string or content-blocks array).
      if (msg.type === "event" && msg.event === "chat") {
        const payload = msg.payload || {};

        if (payload.state === "delta") {
          const text = extractFromPayload(payload);
          if (text) {
            responseText = text; // Delta replaces (accumulates progressively)
            // Emit streaming callback for real-time delivery (e.g., sendMessageDraft)
            if (onDelta) {
              Promise.resolve(onDelta(responseText)).catch((e) => {
                console.warn(`[contract] Delta callback error: ${e.message}`);
              });
            }
          }
          return;
        }

        if (payload.state === "final") {
          // Final message may include the complete text
          const text = extractFromPayload(payload);
          if (text) responseText = text;
          console.log(`[contract] Chat final (${responseText.length} chars)`);
          if (responseText) {
            done(responseText);
          } else {
            // Empty final — log full payload for diagnostics and return ""
            // to signal caller that the bridge got no content.
            console.warn(
              `[contract] Empty final event — payload: ${JSON.stringify(payload).slice(0, 1000)}`,
            );
            done("");
          }
          return;
        }

        if (payload.state === "error") {
          console.error(
            `[contract] Chat error event: ${payload.errorMessage || "unknown"}`,
          );
          done(
            responseText || `Chat error: ${payload.errorMessage || "unknown"}`,
          );
          return;
        }

        if (payload.state === "aborted") {
          done(responseText || "Chat aborted.");
          return;
        }
        return;
      }

      // Step 4: Response to chat.send request (accepted/final)
      if (msg.type === "res" && msg.id === chatReqId) {
        if (!msg.ok) {
          console.error(
            `[contract] Chat error: ${JSON.stringify(msg.error || msg.payload)}`,
          );
          done(
            responseText || `Chat error: ${msg.error?.message || "unknown"}`,
          );
          return;
        }
        // Log full payload for debugging
        const status = msg.payload?.status;
        console.log(
          `[contract] Chat res status=${status} payload=${JSON.stringify(msg.payload).slice(0, 500)}`,
        );
        // "started" or "accepted" = in progress, wait for streaming events
        if (status === "started" || status === "accepted") {
          // Mark runId so the persistent listener skips this response (dedup)
          markBridgeHandledRunId(msg.payload?.runId);
          return;
        }
        // "final" or "done" = completed — return "" if no content (bridge empty)
        if (responseText) {
          done(responseText);
        } else {
          console.warn(
            `[contract] Chat response completed with no streaming content — payload: ${JSON.stringify(msg.payload).slice(0, 500)}`,
          );
          done("");
        }
        return;
      }

      // Unhandled message — log for debugging
      unhandledMsgs.push(raw.slice(0, 300));
    });

    ws.on("error", (err) => {
      console.error(`[contract] WebSocket error: ${err.message}`);
      // Return "" on error so caller can fall back to lightweight agent
      done(responseText || "");
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "";
      const debugInfo =
        unhandledMsgs.length > 0
          ? ` unhandled=[${unhandledMsgs.slice(0, 3).join(" | ")}]`
          : "";
      console.warn(
        `[contract] WebSocket closed: code=${code} reason=${reasonStr} auth=${authenticated} chatSent=${chatSent} responseLen=${responseText.length}${debugInfo}`,
      );
      // Return "" on unexpected close so caller can fall back to lightweight agent
      done(responseText || "");
    });
  });
}

/**
 * Build bridge text from message payload.
 * Handles structured messages with images and plain text.
 */
/**
 * Extract [SEND_FILE:filename] markers AND S3 URLs from response text.
 * Returns { files: [{s3Key, filename, contentType}], cleanText: strippedText }.
 *
 * Two-pass detection:
 *   1. Explicit [SEND_FILE:filename] markers (primary, instruction-based)
 *   2. S3 presigned URLs / S3 URIs containing the user-files bucket name (fallback)
 *
 * The fallback catches cases where the model generates a presigned URL or S3 URI
 * instead of using the [SEND_FILE:] marker, ensuring files are always delivered
 * as native Telegram/Slack attachments rather than raw URLs.
 */
function extractFileMarkers(responseText, namespace) {
  const files = [];
  const sanitize = (s) => {
    let r = s;
    while (r.includes("..")) r = r.replace(/\.\./g, "");
    return r.replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 256);
  };
  const CONTENT_TYPES = {
    pdf: "application/pdf",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif", webp: "image/webp",
    csv: "text/csv", json: "application/json",
    txt: "text/plain", md: "text/markdown",
    html: "text/html", xml: "application/xml", zip: "application/zip",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
  };
  const addFile = (filename) => {
    if (!filename) return;
    if (files.some((f) => f.filename === filename)) return;
    const ext = (filename.split(".").pop() || "").toLowerCase();
    files.push({
      s3Key: `${sanitize(namespace)}/${sanitize(filename)}`,
      filename,
      contentType: CONTENT_TYPES[ext] || "application/octet-stream",
    });
  };

  // Pass 1: Explicit [SEND_FILE:filename] markers
  const MARKER_RE = /\[SEND_FILE:([^\]]+)\]/g;
  let match;
  while ((match = MARKER_RE.exec(responseText)) !== null) {
    addFile(match[1].trim());
  }
  let cleanText = responseText.replace(MARKER_RE, "");

  // Pass 2: S3 presigned URLs and S3 URIs (fallback for model non-compliance)
  const bucket = process.env.S3_USER_FILES_BUCKET;
  if (bucket && namespace) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match https://...{bucket}... or s3://{bucket}/... (greedy to end of non-whitespace)
    const S3_REF_RE = new RegExp(
      `(?:https?://[^\\s<>)\\]]*${esc(bucket)}[^\\s<>)\\]]*|s3://${esc(bucket)}/[^\\s<>)\\]]+)`,
      "gi",
    );
    let urlMatch;
    while ((urlMatch = S3_REF_RE.exec(cleanText)) !== null) {
      const url = urlMatch[0].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
      const pathPart = url.split("?")[0]; // remove query params (presigned URLs)
      // Look for namespace in the path and extract the filename after it
      const nsIdx = pathPart.indexOf(namespace + "/");
      if (nsIdx >= 0) {
        const afterNs = pathPart.slice(nsIdx + namespace.length + 1);
        const rawName = afterNs.split("/").pop() || "";
        try {
          addFile(decodeURIComponent(rawName));
        } catch {
          addFile(rawName);
        }
      }
    }
    cleanText = cleanText.replace(S3_REF_RE, "");
  }

  // Clean up residual whitespace (double spaces, trailing colons from "Download: <url>")
  cleanText = cleanText.replace(/[ \t]{2,}/g, " ").trim();
  return { files, cleanText };
}

function buildBridgeText(message) {
  if (typeof message === "object" && message !== null) {
    let text = message.text || "";
    if (Array.isArray(message.images) && message.images.length > 0) {
      text += "\n\n[OPENCLAW_IMAGES:" + JSON.stringify(message.images) + "]";
    }
    if (Array.isArray(message.documents) && message.documents.length > 0) {
      text += "\n\n[OPENCLAW_DOCUMENTS:" + JSON.stringify(message.documents) + "]";
    }
    if (text) return text;
  }
  if (typeof message === "string") {
    return message;
  }
  return String(message);
}

/**
 * Process a message and deliver the response directly to the user's channel.
 * Used in async mode — runs in the background after returning "accepted".
 *
 * Handles typing indicators, routing (OpenClaw vs lightweight agent),
 * file extraction, and delivery via channel-sender.js.
 */
async function processAndDeliver(bridgeText, actorId, channel, chatId) {
  const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
  const isTelegram = channel === "telegram" && TELEGRAM_BOT_TOKEN;

  // --- Streaming draft state (Telegram only) ---
  // Sends partial text to Telegram via sendMessageDraft (Bot API 9.5) as tokens arrive.
  // Same draftId = animated update of the same draft bubble.
  // Throttled to avoid hitting Telegram's 30 msg/sec rate limit.
  const DRAFT_THROTTLE_MS = 300; // ~3 updates/sec per user
  const DRAFT_MIN_LENGTH = 10; // Don't send drafts for very short text
  let lastDraftTime = 0;
  let streamingActive = false;
  // draft_id must be a non-zero integer, unique per streaming session
  const draftId = isTelegram ? String(Date.now() * 1000000 + Math.floor(Math.random() * 1000000)) : null;

  const onDelta = isTelegram
    ? (accumulatedText) => {
        const now = Date.now();
        if (now - lastDraftTime < DRAFT_THROTTLE_MS) return;
        if (accumulatedText.length < DRAFT_MIN_LENGTH) return;
        lastDraftTime = now;
        if (!streamingActive) {
          console.log(`[contract] Streaming started — first draft at ${accumulatedText.length} chars, draftId=${draftId}`);
        }
        streamingActive = true;
        // Extract content blocks before sending to draft (delta text may still be wrapped)
        const cleanDelta = channelSender.extractTextFromContentBlocks(accumulatedText);
        channelSender.sendTelegramDraft(chatId, cleanDelta, TELEGRAM_BOT_TOKEN, draftId);
      }
    : null;

  // Typing indicator for non-streaming paths (Slack, or fallback)
  let typingTimer = null;
  if (isTelegram) {
    // Send one typing indicator immediately; drafts will replace it
    channelSender.sendTelegramTyping(chatId, TELEGRAM_BOT_TOKEN);
  }

  // One-time progress message after 30s (only if streaming hasn't started)
  const progressTimer = setTimeout(async () => {
    if (streamingActive) return; // Streaming is active — user sees tokens, no need
    const msg =
      "\u23f3 Working on your request \u2014 this may take a few minutes. " +
      "I'll send the full response when it's ready.";
    try {
      if (isTelegram) {
        await channelSender.sendTelegramMessage(chatId, msg, TELEGRAM_BOT_TOKEN);
      } else if (channel === "slack") {
        await channelSender.sendSlackMessage(chatId, msg, SLACK_BOT_TOKEN);
      }
    } catch (e) {
      console.warn(`[contract] Progress message failed: ${e.message}`);
    }
  }, 30000);

  try {
    // Route based on readiness: OpenClaw (full) > lightweight agent (shim)
    let responseText;
    if (openclawReady) {
      try {
        responseText = await enqueueMessage(bridgeText, onDelta);
      } catch (bridgeErr) {
        console.error(
          `[contract] Async bridge error, falling back to shim: ${bridgeErr.message}`,
        );
        responseText = "";
      }
      if (!responseText || !responseText.trim()) {
        console.warn(
          "[contract] Async bridge returned empty — falling back to lightweight agent",
        );
        try {
          responseText = await agent.chat(bridgeText, actorId, Date.now() + 30000);
        } catch (agentErr) {
          responseText =
            "I'm having trouble right now. Please try again in a moment.";
          console.error(
            `[contract] Async lightweight agent fallback error: ${agentErr.message}`,
          );
        }
      }
    } else if (proxyReady) {
      console.log("[contract] Async routing via lightweight agent (warm-up)");
      // Lightweight agent doesn't support streaming yet — use typing indicator
      if (isTelegram) {
        typingTimer = setInterval(() => {
          channelSender.sendTelegramTyping(chatId, TELEGRAM_BOT_TOKEN);
        }, 4000);
      }
      try {
        responseText = await agent.chat(bridgeText, actorId, Date.now() + 3600000);
      } catch (agentErr) {
        responseText =
          "I'm having trouble right now. Please try again in a moment.";
        console.error(
          `[contract] Async lightweight agent error: ${agentErr.message}`,
        );
      }
    } else {
      responseText = "I'm starting up — please try again in a moment.";
    }

    // Log raw response for diagnostics (first 200 chars)
    console.log(
      `[contract] Raw responseText (${responseText.length} chars): ${responseText.slice(0, 200)}`,
    );

    // If response is empty or very short after a long run, the agent likely timed out
    // or hit the tool call limit. Send a user-friendly error instead of silence.
    if (!responseText || !responseText.trim()) {
      responseText =
        "I ran into a problem processing your request — it was taking too long or hit too many retries. " +
        "Could you try again with a simpler request? For example, break it into smaller steps.";
      console.warn("[contract] Empty response — sending timeout/loop error to user");
    }

    // Extract [SEND_FILE:filename] markers and strip from visible text
    const { files, cleanText } = extractFileMarkers(responseText, currentNamespace);

    // Deliver final response directly to channel
    // This replaces the streaming draft with a permanent formatted message
    console.log(
      `[contract] Delivering async response (${cleanText.length} chars, ${files.length} files, streamed=${streamingActive}) to ${channel}:${chatId}`,
    );
    await channelSender.deliverResponse(
      channel, chatId, cleanText, files.length > 0 ? files : null, tokens,
    );
    console.log("[contract] Async response delivered successfully");
  } catch (err) {
    console.error(`[contract] processAndDeliver failed: ${err.message}`);
    try {
      const errorMsg =
        "I'm sorry, something went wrong while processing your request. Please try again.";
      await channelSender.deliverResponse(
        channel, chatId, errorMsg, null, tokens,
      );
    } catch (e) {
      console.error(
        `[contract] Failed to send error message to channel: ${e.message}`,
      );
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    clearTimeout(progressTimer);
  }
}

/**
 * AgentCore contract HTTP server.
 */
const server = http.createServer(async (req, res) => {
  // GET /ping — AgentCore health check
  if (req.method === "GET" && req.url === "/ping") {
    // Return Healthy (not HealthyBusy) — allows natural idle termination.
    // Per-user sessions should terminate when idle.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "Healthy",
        time_of_last_update: Math.floor(Date.now() / 1000),
      }),
    );
    return;
  }

  // POST /invocations — Chat handler
  if (req.method === "POST" && req.url === "/invocations") {
    let body = "";
    let bodySize = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", async () => {
      if (aborted) return;
      try {
        const payload = body ? JSON.parse(body) : {};
        const action = payload.action || "status";

        // Status check (no init needed)
        if (action === "status") {
          // Fetch proxy /health for request counters (non-blocking — null on failure)
          const proxyHealth = await checkProxyHealth();

          const diag = {
            buildVersion: BUILD_VERSION,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
            currentUserId,
            openclawReady,
            proxyReady,
            secretsReady,
            openclawExitCode,
            openclawPid: openclawProcess?.pid || null,
            openclawLogs: openclawLogs.slice(-20),
            totalRequestCount: proxyHealth?.total_requests ?? null,
            subagentRequestCount: proxyHealth?.subagent_requests ?? null,
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: JSON.stringify(diag) }));
          return;
        }

        // Warmup action — trigger lazy init without blocking for a chat response
        if (action === "warmup") {
          const { userId, actorId, channel } = payload;
          if (openclawReady && proxyReady) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ready" }));
            return;
          }
          // Trigger init in background if not already running
          if (!initInProgress && userId && actorId) {
            init(userId, actorId, channel || "unknown").catch((err) => {
              console.error(`[contract] Warmup init failed: ${err.message}`);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "initializing" }));
          return;
        }

        // Cron action — blocks until init completes, then bridges the message
        if (action === "cron") {
          const { userId, actorId, channel, message } = payload;
          if (!userId || !actorId || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Missing userId, actorId, or message" }),
            );
            return;
          }

          // Block until init completes (unlike chat which returns immediately)
          if (!openclawReady || !proxyReady) {
            try {
              if (!initInProgress) {
                await init(userId, actorId, channel || "unknown");
              } else {
                await initPromise;
              }
            } catch (err) {
              console.error(`[contract] Cron init failed: ${err.message}`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  response: "Agent initialization failed for scheduled task.",
                  status: "error",
                }),
              );
              return;
            }
          }

          if (!openclawReady || !proxyReady) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                response: "Agent not ready after initialization.",
                status: "error",
              }),
            );
            return;
          }

          // Enqueue message (serialized with chat messages to prevent WebSocket races)
          let responseText;
          try {
            responseText = await enqueueMessage(message);
          } catch (bridgeErr) {
            responseText = "";
            console.error(
              `[contract] Cron bridge error: ${bridgeErr.message}`,
            );
          }
          // If bridge returned empty, fall back to lightweight agent
          if (!responseText || !responseText.trim()) {
            console.warn(
              "[contract] Cron bridge returned empty — falling back to lightweight agent",
            );
            try {
              responseText = await agent.chat(message, actorId, Date.now() + 30000);
            } catch (agentErr) {
              responseText =
                "I couldn't process this scheduled task. Please check the configuration.";
              console.error(
                `[contract] Cron lightweight agent fallback error: ${agentErr.message}`,
              );
            }
          }

          // Extract [SEND_FILE:filename] markers and strip them from visible text
          const { files: cronFiles, cleanText: cronCleanText } = extractFileMarkers(responseText, currentNamespace);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response: cronCleanText,
              userId: currentUserId,
              sessionId: payload.sessionId || null,
              ...(cronFiles.length > 0 ? { files: cronFiles } : {}),
            }),
          );
          return;
        }

        // Chat action — lazy init and bridge
        if (action === "chat") {
          const { userId, actorId, channel, message, chatId, channelTarget } = payload;
          if (!userId || !actorId || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Missing userId, actorId, or message" }),
            );
            return;
          }

          // Store channel info for async mode
          if (chatId) {
            currentChatId = chatId;
            currentChannel = channel;
          }

          // Trigger init if not done yet (blocks until proxy is ready)
          if (!proxyReady && !initInProgress) {
            try {
              await init(userId, actorId, channel || "unknown");
            } catch (err) {
              console.error(`[contract] Init failed: ${err.message}`);
              // In async mode, send error directly to channel
              if (chatId) {
                const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
                channelSender.deliverResponse(
                  channel, chatId,
                  "I'm having trouble starting up. Please try again in a moment.",
                  null, tokens,
                ).catch((e) => console.error(`[contract] Error delivery failed: ${e.message}`));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "accepted", userId }));
                return;
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  response:
                    "I'm having trouble starting up. Please try again in a moment.",
                  userId,
                  sessionId: payload.sessionId || null,
                  status: "error",
                }),
              );
              return;
            }
          } else if (!proxyReady && initInProgress) {
            // Init already in progress — wait for it
            try {
              await initPromise;
            } catch (err) {
              console.error(
                `[contract] Init (in-progress) failed: ${err.message}`,
              );
              if (chatId) {
                const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
                channelSender.deliverResponse(
                  channel, chatId,
                  "I'm still starting up. Please try again in a moment.",
                  null, tokens,
                ).catch((e) => console.error(`[contract] Error delivery failed: ${e.message}`));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "accepted", userId }));
                return;
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  response:
                    "I'm still starting up. Please try again in a moment.",
                  userId,
                  sessionId: payload.sessionId || null,
                  status: "initializing",
                }),
              );
              return;
            }
          }

          const bridgeText = buildBridgeText(message);

          // --- Async mode: return "accepted" immediately, process in background ---
          if (chatId) {
            console.log(`[contract] Async mode: chatId=${chatId} channel=${channel}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "accepted", userId: currentUserId }));

            // Process and deliver in background (fire-and-forget)
            processAndDeliver(bridgeText, actorId, channel, chatId).catch((err) => {
              console.error(`[contract] processAndDeliver error: ${err.message}`);
            });
            return;
          }

          // --- Sync mode (no chatId): existing behavior for backward compat + cron ---
          // Route based on readiness: OpenClaw (full) > lightweight agent (shim)
          let responseText;
          if (openclawReady) {
            // Full OpenClaw path — WebSocket bridge
            try {
              responseText = await enqueueMessage(bridgeText);
            } catch (bridgeErr) {
              console.error(
                `[contract] Bridge error, falling back to shim: ${bridgeErr.message}`,
              );
              responseText = "";
            }
            // If bridge returned empty (OpenClaw sent no content), fall back to
            // lightweight agent so the user always gets a real AI response.
            if (!responseText || !responseText.trim()) {
              console.warn(
                "[contract] Bridge returned empty — falling back to lightweight agent",
              );
              try {
                responseText = await agent.chat(bridgeText, actorId, Date.now() + 30000);
              } catch (agentErr) {
                responseText =
                  "I'm having trouble right now. Please try again in a moment.";
                console.error(
                  `[contract] Lightweight agent fallback error: ${agentErr.message}`,
                );
              }
            }
          } else if (proxyReady) {
            // Warm-up shim path — lightweight agent via proxy
            console.log("[contract] Routing via lightweight agent (warm-up)");
            try {
              responseText = await agent.chat(bridgeText, actorId, Date.now() + 560000);
            } catch (agentErr) {
              responseText = `I'm having trouble right now. Please try again in a moment.`;
              console.error(
                `[contract] Lightweight agent error: ${agentErr.message}`,
              );
            }
          } else {
            // Proxy not ready yet (should be rare — init awaits proxy)
            responseText = "I'm starting up — please try again in a moment.";
          }

          // Extract [SEND_FILE:filename] markers and strip them from visible text
          const { files, cleanText } = extractFileMarkers(responseText, currentNamespace);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response: cleanText,
              userId: currentUserId,
              sessionId: payload.sessionId || null,
              ...(files.length > 0 ? { files } : {}),
            }),
          );
          return;
        }

        // Unknown action
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ response: "Unknown action", status: "running" }),
        );
      } catch (err) {
        console.error("[contract] Invocation error:", err.message, err.stack);
        // Return 200 with generic error — AgentCore treats 500 as infrastructure failure.
        // Never expose stack traces or internal details to callers.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            response: "An internal error occurred. Please try again.",
          }),
        );
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// --- SIGTERM handler: save workspace and exit gracefully ---
process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    "[contract] SIGTERM received — saving workspace and shutting down",
  );

  // Stop credential refresh timer
  if (credentialRefreshTimer) {
    clearInterval(credentialRefreshTimer);
    credentialRefreshTimer = null;
  }

  // Close persistent chat listener
  if (persistentWsReconnectTimer) {
    clearTimeout(persistentWsReconnectTimer);
    persistentWsReconnectTimer = null;
  }
  if (persistentWs) {
    try { persistentWs.close(); } catch {}
    persistentWs = null;
  }

  // Save workspace to S3 (10s max)
  const saveTimeout = setTimeout(() => {
    console.warn("[contract] Workspace save timeout — exiting");
    process.exit(0);
  }, 10000);

  try {
    await workspaceSync.cleanup(currentNamespace);
  } catch (err) {
    console.warn(`[contract] Workspace cleanup error: ${err.message}`);
  }
  clearTimeout(saveTimeout);

  // Kill child processes
  if (openclawProcess) {
    try {
      openclawProcess.kill("SIGTERM");
    } catch {}
  }
  if (proxyProcess) {
    try {
      proxyProcess.kill("SIGTERM");
    } catch {}
  }

  console.log("[contract] Shutdown complete");
  process.exit(0);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[contract] AgentCore contract server listening on http://0.0.0.0:${PORT} (per-user session mode)`,
  );
  console.log(
    "[contract] Endpoints: GET /ping, POST /invocations {action: chat|status|warmup|cron}",
  );

  // Pre-fetch secrets in background (saves ~2-3s from first-message critical path)
  secretsPrefetchPromise = prefetchSecrets().catch((err) => {
    console.warn(`[contract] Secret prefetch failed: ${err.message}`);
  });
});
