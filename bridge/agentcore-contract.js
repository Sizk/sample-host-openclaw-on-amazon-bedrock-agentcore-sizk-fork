/**
 * AgentCore Runtime Contract Server — Per-User Sessions
 *
 * Implements the required HTTP protocol contract for AgentCore Runtime:
 *   - GET  /ping         -> Health check (Healthy — allows idle termination)
 *   - POST /invocations  -> Chat handler with lazy init
 *
 * Each AgentCore session is dedicated to a single user. On first invocation:
 *   1. Use pre-fetched secrets (fetched eagerly at boot)
 *   2. Start proxy + workspace restore + Lightpanda in parallel
 *   3. Once proxy is ready (~5s), route all messages via custom agent
 *
 * The custom agent provides ~5s cold start (proxy only).
 * No WebSocket bridge, no device pairing, no persistent listener.
 *
 * Runs on port 8080 (required by AgentCore Runtime).
 */

const http = require("http");
const { spawn } = require("child_process");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const workspaceSync = require("./workspace-sync");
const customAgent = require("./custom-agent");
const scopedCreds = require("./scoped-credentials");
const channelSender = require("./channel-sender");
const lightpandaFetch = require("./lightpanda-fetch");

const PORT = 8080;
const PROXY_PORT = 18790;

// Gateway token — fetched from Secrets Manager eagerly at boot.
// Still needed for proxy identity context (Cognito user provisioning).
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
let proxyProcess = null;
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
const BUILD_VERSION = "v36"; // Bump in cdk.json to force container redeploy

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

// AGENTS.md content — canonical operating instructions for the AI agent.
// Written to S3 at {namespace}/AGENTS.md on every init so the proxy's system
// prompt injection always has the latest instructions.
const AGENTS_MD_CONTENT = [
  "# Agent Instructions",
  "",
  "You are a helpful AI assistant running in a per-user container on AWS.",
  "You have built-in web tools, file storage, scheduling, and code execution capabilities.",
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
  "- **web_fetch**: Fetch and read web page content (basic HTTP — good for simple pages and APIs)",
  "",
  "Use these for real-time information, news, research, and reading web pages.",
  "**IMPORTANT**: web_fetch is plain HTTP — it does NOT render JavaScript. For JS-heavy sites,",
  "cookie walls, or dynamic content, you MUST use Puppeteer or Scrapling (see below).",
  "",
  "## Web Scraping — Use the Right Tool!",
  "",
  "A Lightpanda headless browser is ALWAYS running at `ws://127.0.0.1:9222` (CDP protocol).",
  "You have THREE scraping approaches — choose based on the site:",
  "",
  "### 1. Puppeteer + Lightpanda (PREFERRED for JS-rendered sites)",
  "**Use this for**: Fotocasa, pisos.com, yaencontre, globaliza, nestoria, and ANY site that",
  "needs JavaScript rendering, cookie consent handling, or dynamic content loading.",
  "Lightpanda is 10x faster and uses 10x less memory than Chrome.",
  "```javascript",
  "const puppeteer = require('puppeteer-core');",
  "const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222' });",
  "const page = await (await browser.createBrowserContext()).newPage();",
  "await page.goto('https://example.com', { waitUntil: 'networkidle0', timeout: 30000 });",
  "// Accept cookie banners if present",
  "await page.evaluate(() => {",
  "  const btns = [...document.querySelectorAll('button')];",
  "  const accept = btns.find(b => /accept|aceptar|acepto/i.test(b.textContent));",
  "  if (accept) accept.click();",
  "});",
  "await new Promise(r => setTimeout(r, 1000)); // Wait for content to load after cookies",
  "const data = await page.evaluate(() => document.body.innerText);",
  "await page.close(); await browser.disconnect();",
  "```",
  "",
  "### 2. Scrapling (Python, for TLS-impersonating requests)",
  "For sites that block bots based on TLS fingerprinting (Fotocasa API, etc.):",
  "```python",
  "from scrapling.fetchers import Fetcher",
  "page = Fetcher.get('https://example.com', impersonate='chrome')",
  "items = page.css('.item').getall()  # CSS selectors like Scrapy",
  "texts = page.css('.title::text').getall()  # Extract text",
  "```",
  "",
  "### 3. web_fetch (for simple, static pages only)",
  "Only use web_fetch for pages that work without JavaScript (APIs, static HTML, RSS feeds).",
  "",
  "### Scraping Strategy (FOLLOW THIS ORDER)",
  "1. **First try Puppeteer + Lightpanda** for any real estate portal, news site, or JS-heavy page",
  "2. If Puppeteer fails (CAPTCHA, anti-bot), try **Scrapling** with TLS impersonation",
  "3. Only fall back to **web_fetch** for simple/static pages or APIs",
  "",
  "**Works on**: Most JS-rendered sites, SPAs, Fotocasa, pisos.com, yaencontre, globaliza, nestoria, cookie walls.",
  "**Does NOT work on**: Idealista (DataDome CAPTCHA), Milanuncios (CAPTCHA).",
  "",
  "## Scheduling & Cron Jobs",
  "",
  "You have the **eventbridge-cron** scheduling tools. When users ask to:",
  "- Set up reminders, alarms, or scheduled messages",
  "- Create recurring tasks or cron jobs",
  "- Schedule daily, weekly, or periodic actions",
  "",
  "**Use the scheduling tools.** Do NOT say cron is disabled.",
  "Scheduling is powered by Amazon EventBridge Scheduler (reliable, persists across sessions).",
  "",
  "Always ask the user for their **timezone** if you don't know it (e.g., Asia/Shanghai, America/New_York).",
  "",
  "## Memory Persistence (IMPORTANT)",
  "",
  "Your conversation history does NOT survive across sessions. To remember things permanently,",
  "you MUST save them to files using the file storage tools. Check these files at the START of every conversation:",
  "",
  "- **USER.md**: User preferences — timezone, language, name, interests, communication style.",
  "  When the user tells you their timezone, name, preferences, or any personal info, IMMEDIATELY",
  "  update USER.md with `write_user_file`.",
  "- **MEMORY.md**: Things the user explicitly asks you to remember ('remember that...', 'note that...').",
  "  Always save these immediately — don't just acknowledge, actually write to MEMORY.md.",
  "",
  "At the start of each conversation, read USER.md and MEMORY.md to restore context.",
  "If they exist, greet the user by name and reference known preferences.",
  "",
  "## File Storage",
  "",
  "You have persistent file storage tools: read_user_file, write_user_file, list_user_files, delete_user_file.",
  "Files survive across sessions.",
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
  "2. Upload: `write_user_file` with file_path pointing to the local file",
  "3. Deliver: include `[SEND_FILE:filename]` in your response",
  "",
  "The `[SEND_FILE:filename]` marker delivers the file as a native attachment in Telegram/Slack.",
  "",
  "### CRITICAL: Writing large content to files",
  "",
  "**Never pass large content as bash command arguments** — it will overflow tool argument limits.",
  "Always use bash heredoc to write to /tmp, then upload with file_path:",
  "```bash",
  "cat > /tmp/output.html << 'FILEEOF'",
  "<!DOCTYPE html>",
  "<html><body><h1>Title</h1><p>Content here...</p></body></html>",
  "FILEEOF",
  "```",
  "Then: `write_user_file` with filename='output.html' and file_path='/tmp/output.html'",
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
  "| `openpyxl` | Excel spreadsheets (.xlsx) |",
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
  "Then: `write_user_file` with filename='chart.png' and file_path='/tmp/chart.png' + `[SEND_FILE:chart.png]`",
  "",
  "## Task Delegation & Sub-Agents",
  "",
  "You can spawn parallel sub-agents for complex multi-step tasks using the `spawn_subagents` tool.",
  "Each sub-agent runs independently with its own Bedrock conversation loop.",
  "",
  "### Rules:",
  "1. ALWAYS acknowledge the user's request within seconds",
  "2. For simple questions/chat → answer directly (no sub-agent needed)",
  "3. For complex tasks → tell the user you're starting the work, then use spawn_subagents to delegate",
  "4. Sub-agents share your tools: exec, web_fetch, web_search, file tools",
  "",
  "### Sub-Agent Types:",
  "- **web_scraping**: Puppeteer + Lightpanda + Scrapling for data extraction",
  "- **finance**: Stock prices, portfolio analysis, financial data + charts",
  "- **research**: In-depth analysis with web_search + web_fetch + jina-reader",
  "- **data_processing**: File analysis, CSV/Excel processing, report generation",
  "- **general**: All tools available",
  "",
  "### What to handle directly (NO sub-agent needed):",
  "- Greetings, simple questions, conversation",
  "- Single web_fetch or web_search",
  "- Quick lookups (weather, time, simple facts)",
  "- Reading/writing memory files (USER.md, MEMORY.md)",
  "- Creating/managing cron schedules",
  "",
  "## Task Templates (IMPORTANT)",
  "",
  "TASKS.md is a lightweight index of reusable task templates stored as individual files",
  "(e.g. task_terrenos.md, task_portfolio.md). Each task file defines: sources to scrape,",
  "filters/constraints, and the exact output format for a specific recurring task.",
  "",
  "### Workflow:",
  "1. Before executing a complex task, check TASKS.md index for a matching template",
  "2. If found, read the individual task file with `read_user_file` to get the full template",
  "3. Follow the template's filters, sources, and output format STRICTLY",
  "4. Pass the template's filters AND output format to sub-agents in their task descriptions",
  "5. If the user gives feedback on the output ('quiero enlaces directos', 'ordena por precio',",
  "   'no incluyas terrenos rústicos'), update the relevant task file AND confirm the change",
  "",
  "### Creating new task templates:",
  "When a user runs a complex task for the first time and expresses preferences about the",
  "output format, filters, or sources — offer to save it as a reusable template.",
  "When saving: create the task file with `write_user_file`, then update TASKS.md index.",
  "",
  "### Keeping TASKS.md in sync:",
  "- Creating a task file → MUST add a row to TASKS.md",
  "- Deleting a task file → MUST remove the row from TASKS.md",
  "- TASKS.md must ALWAYS accurately reflect which task files actually exist",
  "",
].join("\n");

/**
 * Write AGENTS.md to S3 at {namespace}/AGENTS.md (top-level).
 * The proxy reads from this path to inject instructions into the system prompt.
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
      // in JSON strings but may appear in bridge responses.
      const sanitized = trimmed.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      const forParse = sanitized
        .replace(/\t/g, "\\t")
        .replace(/\r\n/g, "\\n")
        .replace(/\r/g, "\\n")
        .replace(/\n/g, "\\n");
      try {
        let parsed;
        try {
          parsed = JSON.parse(forParse);
        } catch {
          parsed = JSON.parse(sanitized);
        }
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
      const prefixMatch = trimmed.match(
        /^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/,
      );
      if (prefixMatch) {
        let inner = trimmed.slice(prefixMatch[0].length);
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
 * Extract [SEND_FILE:filename] markers AND S3 URLs from response text.
 * Returns { files: [{s3Key, filename, contentType}], cleanText: strippedText }.
 *
 * Two-pass detection:
 *   1. Explicit [SEND_FILE:filename] markers (primary, instruction-based)
 *   2. S3 presigned URLs / S3 URIs containing the user-files bucket name (fallback)
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
    const S3_REF_RE = new RegExp(
      `(?:https?://[^\\s<>)\\]]*${esc(bucket)}[^\\s<>)\\]]*|s3://${esc(bucket)}/[^\\s<>)\\]]+)`,
      "gi",
    );
    let urlMatch;
    while ((urlMatch = S3_REF_RE.exec(cleanText)) !== null) {
      const url = urlMatch[0].replace(/[.,;:!?]+$/, "");
      const pathPart = url.split("?")[0];
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

  // Clean up residual whitespace
  cleanText = cleanText.replace(/[ \t]{2,}/g, " ").trim();
  return { files, cleanText };
}

/**
 * Build message text from invocation payload.
 * Handles structured messages with images and plain text.
 */
function buildMessageText(message) {
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
 * Initialization — called on first /invocations request.
 *
 * Uses pre-fetched secrets. Starts proxy and workspace restore in parallel.
 * Only waits for proxy readiness (~5s), then returns.
 * Custom agent handles everything via proxy -> Bedrock.
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
    if (!COGNITO_PASSWORD_SECRET) {
      console.log(
        "[contract] Secrets missing — retrying secrets fetch...",
      );
      await prefetchSecrets();
    }

    // 1. Create scoped S3 credentials (per-user IAM isolation)
    let scopedCredsAvailable = false;
    if (process.env.EXECUTION_ROLE_ARN) {
      try {
        console.log(`[contract] Creating scoped S3 credentials for namespace=${namespace}...`);
        const creds = await scopedCreds.createScopedCredentials(namespace);
        scopedCreds.writeCredentialFiles(creds, SCOPED_CREDS_DIR);
        workspaceSync.configureCredentials(creds);
        scopedCredsAvailable = true;
        console.log("[contract] Scoped S3 credentials created and applied");

        // Pass scoped credentials env to custom agent's exec tool
        customAgent.setExecEnv({
          AWS_CONFIG_FILE: `${SCOPED_CREDS_DIR}/scoped-aws-config`,
          AWS_SDK_LOAD_CONFIG: "1",
        });

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
      }
    } else {
      console.log("[contract] EXECUTION_ROLE_ARN not set — skipping credential scoping");
    }

    // 2. Start the Bedrock proxy with user identity env vars
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
      SUBAGENT_MODEL_NAME: "bedrock-agentcore-subagent",
      SUBAGENT_BEDROCK_MODEL_ID: process.env.SUBAGENT_BEDROCK_MODEL_ID || "",
      USER_ID: actorId,
      CHANNEL: channel,
    };
    proxyProcess = spawn("node", ["/app/agentcore-proxy.js"], {
      env: proxyEnv,
      stdio: "inherit",
    });
    proxyProcess.on("exit", (code) => {
      console.log(`[contract] Proxy exited with code ${code}`);
      proxyReady = false;
    });

    // 3. Restore workspace from S3 (non-blocking)
    workspaceSync.restoreWorkspace(namespace).catch((err) => {
      console.warn(`[contract] Workspace restore failed: ${err.message}`);
    });

    // Write AGENTS.md to S3 (non-blocking)
    writeAgentsMdToS3(namespace).catch((err) => {
      console.warn(`[contract] AGENTS.md S3 write failed: ${err.message}`);
    });

    // 4. Wait only for proxy readiness (~5s)
    proxyReady = await waitForPort(PROXY_PORT, "Proxy", 30000, 1000);
    if (!proxyReady) {
      throw new Error("Proxy failed to start within 30s");
    }

    // 5. Start periodic workspace saves
    workspaceSync.startPeriodicSave(namespace);

    // 6. Warm proxy JIT (non-blocking)
    warmProxyJit().catch(() => {});

    // 7. Auto-start Lightpanda headless browser (CDP on port 9222)
    lightpandaFetch.ensureLightpandaRunning().then((ok) => {
      if (ok) console.log("[contract] Lightpanda auto-started — available at ws://127.0.0.1:9222");
      else console.warn("[contract] Lightpanda auto-start failed — web_fetch will use basic HTTP");
    }).catch(() => {});

    console.log(
      "[contract] Init complete — proxy ready, custom agent active",
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

// ---------------------------------------------------------------------------
// Message queue — serialize chat() calls to prevent race conditions.
// When agent is busy (processing a message), new messages are queued.
// Status queries while sub-agents run get an immediate response.
// ---------------------------------------------------------------------------

let chatBusy = false;
const messageQueue = []; // { messageText, actorId, channel, chatId }

/**
 * Detect if a message is a status/progress query.
 * These get immediate responses when sub-agents are running.
 */
function isStatusQuery(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase().trim();
  // Strip leading punctuation/emoji so "?? como vas?" or "!! how's it going" still match
  const stripped = lower.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const patterns = [
    /^(como|cómo)\s+(va|vas|vamos)/,          // Spanish: "como va", "como vas", "como vamos"
    /^(que|qué)\s+tal\s+(va|vas)/,             // Spanish: "que tal va", "que tal vas"
    /^(how('s| is|s)?\s+(it|that|the task)?\s*(going|progressing|doing))/,  // English
    /^status\b/,                                // "status", "status?"
    /^progress\b/,                              // "progress", "progress?"
    /^(sigues|estas|estás)\s+(ahí|ahi|trabajando)/,  // Spanish: "sigues ahi"
    /^(still|are you)\s+(there|working|running)/,     // English: "still there"
    /^(en que|en qué)\s+(andas|vas|estas|estás)/,     // Spanish: "en que andas"
    /^(what'?s?\s+happening|what are you doing)/,     // English
    /^(como|cómo)\s+va\s+(el|la|eso)/,         // Spanish: "como va el tema", "como va eso"
    /^(que|qué)\s+(haces|estas haciendo|estás haciendo)/, // Spanish: "que haces", "que estas haciendo"
  ];
  // Match on both original (for "?" / "??") and stripped (for "?? como vas?")
  return /^\?+$/.test(lower) || patterns.some((p) => p.test(stripped));
}

/**
 * Format sub-agent status as a user-friendly message.
 * NEVER expose internal details: tool names, commands, URLs, step counts.
 * Present a clean, human-readable progress summary.
 */
function formatSubagentStatus(status) {
  if (!status) return null;
  const elapsed = status.elapsedSeconds;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const total = status.agents.length;
  const completed = status.agents.filter((a) => a.status === "completed").length;
  const running = status.agents.filter((a) => a.status === "running" || a.status === "starting").length;

  // User-friendly task descriptions — strip internal jargon and URLs from descriptions
  const taskSummaries = status.agents.map((a) => {
    const emoji = a.status === "completed" ? "\u2705" : a.status === "running" ? "\u23f3" : "\u2699\ufe0f";
    // Use the task description (set by main agent), clean URLs to avoid link previews
    const desc = (a.description || "Processing").replace(/https?:\/\/\S+/g, "").trim() || "Processing";
    return `${emoji} ${desc}`;
  });

  let msg = `Working on it (${timeStr} elapsed).`;
  if (total > 1) {
    msg += ` ${completed}/${total} tasks done.`;
  }
  msg += `\n\n${taskSummaries.join("\n")}`;

  return msg;
}

/**
 * Process queued messages one at a time.
 */
async function drainQueue() {
  while (messageQueue.length > 0) {
    const next = messageQueue.shift();
    console.log(`[contract] Processing queued message (${messageQueue.length} remaining, isCron=${!!next.isCron})`);
    try {
      await processAndDeliver(next.messageText, next.actorId, next.channel, next.chatId, { isCron: !!next.isCron });
    } catch (err) {
      console.error(`[contract] Queued processAndDeliver error: ${err.message}`);
    }
  }
  chatBusy = false;
}

/**
 * Process a message and deliver the response directly to the user's channel.
 * Used in async mode — runs in the background after returning "accepted".
 *
 * Routes all messages through custom agent. Handles typing indicators,
 * Telegram streaming drafts, file extraction, and delivery via channel-sender.js.
 */
async function processAndDeliver(messageText, actorId, channel, chatId, options = {}) {
  const { isCron = false } = options;
  const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
  const isTelegram = channel === "telegram" && TELEGRAM_BOT_TOKEN;

  // --- Streaming draft state (Telegram only) ---
  const DRAFT_THROTTLE_MS = 300;
  const DRAFT_MIN_LENGTH = 10;
  const DRAFT_STARTUP_DELAY_MS = 3000; // Don't start streaming for the first 3s (avoids ghost drafts on short responses)
  let lastDraftTime = 0;
  let streamingActive = false;
  const draftId = isTelegram ? String(Date.now() * 1000000 + Math.floor(Math.random() * 1000000)) : null;
  const streamStartTime = Date.now();

  const onDelta = isTelegram
    ? (accumulatedText) => {
        const now = Date.now();
        if (now - streamStartTime < DRAFT_STARTUP_DELAY_MS) return; // Skip early drafts
        if (now - lastDraftTime < DRAFT_THROTTLE_MS) return;
        if (accumulatedText.length < DRAFT_MIN_LENGTH) return;
        lastDraftTime = now;
        if (!streamingActive) {
          console.log(`[contract] Streaming started — first draft at ${accumulatedText.length} chars, draftId=${draftId}`);
        }
        streamingActive = true;
        const cleanDelta = channelSender.extractTextFromContentBlocks(accumulatedText);
        channelSender.sendTelegramDraft(chatId, cleanDelta, TELEGRAM_BOT_TOKEN, draftId);
      }
    : null;

  // Typing indicator for non-streaming paths
  let typingTimer = null;
  if (isTelegram) {
    channelSender.sendTelegramTyping(chatId, TELEGRAM_BOT_TOKEN);
    typingTimer = setInterval(() => {
      channelSender.sendTelegramTyping(chatId, TELEGRAM_BOT_TOKEN);
    }, 4000);
  }

  // One-time progress message after 30s (only if streaming hasn't started, and NOT for cron tasks)
  const progressTimer = isCron ? null : setTimeout(async () => {
    if (streamingActive) return;
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
    let responseText;

    if (proxyReady) {
      console.log("[contract] Routing via custom agent");
      try {
        responseText = await customAgent.chat(messageText, actorId, 0, onDelta);
      } catch (agentErr) {
        responseText = "I'm having trouble right now. Please try again in a moment.";
        console.error(`[contract] Custom agent error: ${agentErr.message}`);
      }
    } else {
      responseText = "I'm starting up — please try again in a moment.";
    }

    // Log raw response for diagnostics
    console.log(
      `[contract] Raw responseText (${responseText.length} chars): ${responseText.slice(0, 200)}`,
    );

    // If response is empty, send user-friendly error
    if (!responseText || !responseText.trim()) {
      responseText =
        "I ran into a problem processing your request. " +
        "Could you try again with a simpler request? For example, break it into smaller steps.";
      console.warn("[contract] Empty response — sending error to user");
    }

    // Extract [SEND_FILE:filename] markers and strip from visible text
    const { files, cleanText } = extractFileMarkers(responseText, currentNamespace);

    // Deliver final response directly to channel
    console.log(
      `[contract] Delivering response (${cleanText.length} chars, ${files.length} files, streamed=${streamingActive}) to ${channel}:${chatId}`,
    );
    await channelSender.deliverResponse(
      channel, chatId, cleanText, files.length > 0 ? files : null, tokens,
      streamingActive ? draftId : null,
    );
    console.log("[contract] Response delivered successfully");
  } catch (err) {
    console.error(`[contract] processAndDeliver failed: ${err.message}`);
    try {
      const errorMsg =
        "I'm sorry, something went wrong while processing your request. Please try again.";
      await channelSender.deliverResponse(
        channel, chatId, errorMsg, null, tokens,
        streamingActive ? draftId : null, // Replace orphaned draft if streaming was active
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
          const proxyHealth = await checkProxyHealth();
          const diag = {
            buildVersion: BUILD_VERSION,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
            currentUserId,
            proxyReady,
            secretsReady,
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
          if (proxyReady) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ready" }));
            return;
          }
          if (!initInProgress && userId && actorId) {
            init(userId, actorId, channel || "unknown").catch((err) => {
              console.error(`[contract] Warmup init failed: ${err.message}`);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "initializing" }));
          return;
        }

        // Cron action — init if needed, then process via custom agent.
        // If chatId is provided, use async direct delivery (like chat);
        // otherwise fall back to synchronous response (legacy).
        if (action === "cron") {
          const { userId, actorId, channel, message, chatId } = payload;
          if (!userId || !actorId || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Missing userId, actorId, or message" }),
            );
            return;
          }

          // Store channel info for delivery
          if (chatId) {
            currentChatId = chatId;
            currentChannel = channel;
          }

          // Block until init completes
          if (!proxyReady) {
            try {
              if (!initInProgress) {
                await init(userId, actorId, channel || "unknown");
              } else {
                await initPromise;
              }
            } catch (err) {
              console.error(`[contract] Cron init failed: ${err.message}`);
              if (chatId) {
                const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
                channelSender.deliverResponse(
                  channel, chatId,
                  "Your scheduled task could not run because the agent failed to start.",
                  null, tokens,
                ).catch((e) => console.error(`[contract] Cron error delivery failed: ${e.message}`));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "accepted", userId }));
                return;
              }
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

          if (!proxyReady) {
            if (chatId) {
              const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
              channelSender.deliverResponse(
                channel, chatId,
                "Your scheduled task could not run because the agent is not ready.",
                null, tokens,
              ).catch((e) => console.error(`[contract] Cron error delivery failed: ${e.message}`));
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "accepted", userId }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                response: "Agent not ready after initialization.",
                status: "error",
              }),
            );
            return;
          }

          // --- Async mode (chatId present): return immediately, deliver in background ---
          if (chatId) {
            console.log(`[contract] Cron async mode: chatId=${chatId} channel=${channel} busy=${chatBusy}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "accepted", userId: currentUserId }));

            // If agent is already busy (another cron or user message), queue the cron message
            if (chatBusy) {
              console.log(`[contract] Agent busy — queuing cron message (queue size: ${messageQueue.length})`);
              messageQueue.push({ messageText: message, actorId, channel, chatId, isCron: true });
              return;
            }

            // Process cron in background with chatBusy lock (same as chat messages)
            chatBusy = true;
            processAndDeliver(message, actorId, channel, chatId, { isCron: true })
              .catch((err) => {
                console.error(`[contract] Cron processAndDeliver error: ${err.message}`);
              })
              .then(() => {
                // Drain any queued messages (user or cron)
                if (messageQueue.length > 0) {
                  drainQueue().catch((err) => {
                    console.error(`[contract] drainQueue error: ${err.message}`);
                    chatBusy = false;
                  });
                } else {
                  chatBusy = false;
                }
              });
            return;
          }

          // --- Sync mode (no chatId): legacy — block until response ---
          let responseText;
          try {
            responseText = await customAgent.chat(message, actorId, Date.now() + 3600000);
          } catch (agentErr) {
            responseText =
              "I couldn't process this scheduled task. Please check the configuration.";
            console.error(
              `[contract] Cron agent error: ${agentErr.message}`,
            );
          }

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

        // Chat action — lazy init and route to custom agent
        if (action === "chat") {
          const { userId, actorId, channel, message, chatId } = payload;
          if (!userId || !actorId || !message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Missing userId, actorId, or message" }),
            );
            return;
          }

          // Store channel info
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
                  response: "I'm having trouble starting up. Please try again in a moment.",
                  userId,
                  sessionId: payload.sessionId || null,
                  status: "error",
                }),
              );
              return;
            }
          } else if (!proxyReady && initInProgress) {
            try {
              await initPromise;
            } catch (err) {
              console.error(`[contract] Init (in-progress) failed: ${err.message}`);
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
                  response: "I'm still starting up. Please try again in a moment.",
                  userId,
                  sessionId: payload.sessionId || null,
                  status: "initializing",
                }),
              );
              return;
            }
          }

          const messageText = buildMessageText(message);

          // --- Async mode: return "accepted" immediately, process in background ---
          if (chatId) {
            console.log(`[contract] Async mode: chatId=${chatId} channel=${channel} busy=${chatBusy}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "accepted", userId: currentUserId }));

            // If agent is busy, check if this is a status query
            if (chatBusy) {
              if (isStatusQuery(messageText)) {
                const status = customAgent.getSubagentStatus();
                if (status) {
                  // Sub-agents running — respond with detailed progress
                  const statusMsg = formatSubagentStatus(status);
                  console.log(`[contract] Status query while busy (subagents active) — responding immediately`);
                  const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
                  channelSender.deliverResponse(channel, chatId, statusMsg, null, tokens)
                    .catch((e) => console.error(`[contract] Status delivery failed: ${e.message}`));
                } else {
                  // Busy but no sub-agents — send a brief acknowledgment
                  console.log(`[contract] Status query while busy (no subagents) — sending ack`);
                  const ackMsg = "Working on your previous message — I'll respond as soon as I'm done.";
                  const tokens = { telegram: TELEGRAM_BOT_TOKEN, slack: SLACK_BOT_TOKEN };
                  channelSender.deliverResponse(channel, chatId, ackMsg, null, tokens)
                    .catch((e) => console.error(`[contract] Ack delivery failed: ${e.message}`));
                }
                return;
              }

              // Not a status query — queue the message
              console.log(`[contract] Agent busy — queuing message (queue size: ${messageQueue.length})`);
              messageQueue.push({ messageText, actorId, channel, chatId });
              return;
            }

            // Agent not busy — process immediately
            chatBusy = true;
            processAndDeliver(messageText, actorId, channel, chatId)
              .catch((err) => {
                console.error(`[contract] processAndDeliver error: ${err.message}`);
              })
              .then(() => {
                // Drain any queued messages
                if (messageQueue.length > 0) {
                  drainQueue().catch((err) => {
                    console.error(`[contract] drainQueue error: ${err.message}`);
                    chatBusy = false;
                  });
                } else {
                  chatBusy = false;
                }
              });
            return;
          }

          // --- Sync mode (no chatId): for backward compat + cron ---
          let responseText;
          if (proxyReady) {
            try {
              responseText = await customAgent.chat(messageText, actorId, Date.now() + 560000);
            } catch (agentErr) {
              responseText = "I'm having trouble right now. Please try again in a moment.";
              console.error(`[contract] Custom agent error: ${agentErr.message}`);
            }
          } else {
            responseText = "I'm starting up — please try again in a moment.";
          }

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
  if (proxyProcess) {
    try {
      proxyProcess.kill("SIGTERM");
    } catch {}
  }
  // Stop Lightpanda browser server
  lightpandaFetch.stopLightpanda();

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
