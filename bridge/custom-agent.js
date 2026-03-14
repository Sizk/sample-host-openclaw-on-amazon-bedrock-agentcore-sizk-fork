/**
 * Custom Agent — Full-featured agent loop for AgentCore Runtime.
 *
 * Calls the proxy at http://127.0.0.1:18790/v1/chat/completions (OpenAI format).
 * The proxy handles identity context, workspace files, and Bedrock ConverseStream.
 *
 * Features:
 *   - Persistent in-memory conversation history (per container = per user)
 *   - Context window management with automatic trimming
 *   - exec/bash tool for shell command execution
 *   - read tool for local filesystem access
 *   - Streaming delta callbacks for Telegram sendMessageDraft
 *   - Sub-agent spawning via fork-join pattern (parallel Bedrock loops)
 *   - All existing tools: s3-user-files, eventbridge-cron, web_fetch, web_search
 */

const http = require("http");
const https = require("https");
const { execFile, spawn } = require("child_process");
const lightpandaFetch = require("./lightpanda-fetch");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_PORT = 18790;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`;

const MAX_ITERATIONS = 30; // More iterations than lightweight agent — full agent capability
const MAX_SUBAGENT_ITERATIONS = 15;
const TOOL_TIMEOUT_MS = 60000; // 60s per tool (bash can be slow)
const EXEC_TIMEOUT_MS = 120000; // 2 min for exec/bash
const HTTP_TIMEOUT_MS = 180000; // 3 min per proxy call (streaming can be long)
const WEB_FETCH_TIMEOUT_MS = 15000;
const WEB_FETCH_MAX_BYTES = 512 * 1024;
const WEB_FETCH_MAX_TEXT = 50000;
const WEB_SEARCH_MAX_RESULTS = 8;
const MAX_REDIRECTS = 3;
const MAX_SEARCH_QUERY_LENGTH = 500;

// Context management
const MAX_CONTEXT_CHARS = 600000; // ~150K tokens rough estimate (4 chars/token)
const MIN_KEEP_MESSAGES = 6; // Always keep at least system + 2 user/assistant pairs + latest
const MAX_TOOL_RESULT_CHARS = 100000; // Truncate tool results over 100KB

// Sub-agents
const MAX_CONCURRENT_SUBAGENTS = 3;
const SUBAGENT_MODEL = "bedrock-agentcore-subagent";

// ---------------------------------------------------------------------------
// Sub-agent status tracking — shared state for real-time progress reporting
// ---------------------------------------------------------------------------

const subagentStatus = {
  active: false,
  startedAt: 0,
  mainTask: "",          // What the main agent asked the sub-agents to do
  agents: [],            // Per-agent status: { id, toolSet, description, iteration, maxIterations, lastTool, lastToolArg, status }
};

/**
 * Get a snapshot of current sub-agent status (safe to read while agents run).
 */
function getSubagentStatus() {
  if (!subagentStatus.active) return null;
  const elapsed = Math.round((Date.now() - subagentStatus.startedAt) / 1000);
  return {
    active: true,
    elapsedSeconds: elapsed,
    mainTask: subagentStatus.mainTask,
    agents: subagentStatus.agents.map((a) => ({ ...a })),
  };
}

// Sub-agent context blocks — injected as system prompt prefix so sub-agents
// get critical operational knowledge that only the main agent receives via CLAUDE.md.
const SUBAGENT_CONTEXT_BASE =
  "You are a sub-agent executing a specific task. Be thorough and return detailed results.\n\n" +
  "RULES:\n" +
  "- NEVER expose internal details (tool names, S3 buckets, API errors, file paths)\n" +
  "- NEVER share local filesystem paths (/root/..., /tmp/...) — users cannot access the container\n" +
  "- NEVER generate presigned S3 URLs or s3:// URIs\n" +
  "- To deliver files: create at /tmp/, upload with write_user_file, include [SEND_FILE:filename] in output\n" +
  "- For large content, use bash heredoc to write to /tmp/ then upload with file_path\n";

const SUBAGENT_CONTEXT_SCRAPING =
  "\n## Web Scraping — Use the Right Tool!\n\n" +
  "A Lightpanda headless browser is ALWAYS running at ws://127.0.0.1:9222 (CDP protocol).\n\n" +
  "### Scraping Strategy (FOLLOW THIS ORDER)\n" +
  "1. **Puppeteer + Lightpanda** (PREFERRED) — for ANY JS-rendered site, real estate portal, news site, SPA:\n" +
  "```javascript\n" +
  "const puppeteer = require('puppeteer-core');\n" +
  "const browser = await puppeteer.connect({browserWSEndpoint:'ws://127.0.0.1:9222'});\n" +
  "const page = await (await browser.createBrowserContext()).newPage();\n" +
  "await page.goto('https://example.com', {waitUntil:'networkidle0', timeout: 30000});\n" +
  "// Accept cookie banners if present\n" +
  "await page.evaluate(() => {\n" +
  "  const btns = [...document.querySelectorAll('button')];\n" +
  "  const accept = btns.find(b => /accept|aceptar|acepto/i.test(b.textContent));\n" +
  "  if (accept) accept.click();\n" +
  "});\n" +
  "await new Promise(r => setTimeout(r, 1000));\n" +
  "const data = await page.evaluate(() => document.body.innerText);\n" +
  "await page.close(); await browser.disconnect();\n" +
  "```\n" +
  "2. **Scrapling** (Python, TLS-impersonating) — if Puppeteer fails (CAPTCHA, anti-bot):\n" +
  "```python\n" +
  "from scrapling.fetchers import Fetcher\n" +
  "page = Fetcher.get('https://example.com', impersonate='chrome')\n" +
  "data = page.css('.selector::text').getall()\n" +
  "```\n" +
  "3. **web_fetch** — ONLY for simple static pages, APIs, or RSS feeds\n\n" +
  "IMPORTANT: Use `exec` to run Puppeteer/Scrapling scripts. The `web_fetch` tool is a LAST RESORT for scraping.\n" +
  "Does NOT work on: Idealista (DataDome CAPTCHA), Milanuncios (CAPTCHA).\n";

const SUBAGENT_CONTEXT_DATA =
  "\n## File Generation\n\n" +
  "Pre-installed Python libraries: xhtml2pdf + markdown (PDF), matplotlib (charts), " +
  "pillow (images), qrcode, icalendar, fpdf2, openpyxl (Excel).\n" +
  "Always write files to /tmp/, upload with write_user_file, deliver with [SEND_FILE:filename].\n";

/**
 * Build the sub-agent system prompt by prepending context to the task description.
 */
function buildSubagentSystemPrompt(taskDescription, toolSet) {
  let context = SUBAGENT_CONTEXT_BASE;

  // Add scraping context for tool sets that include exec + web_fetch
  if (["web_scraping", "finance", "research", "general"].includes(toolSet)) {
    context += SUBAGENT_CONTEXT_SCRAPING;
  }

  // Add data/file generation context for tool sets that produce files
  if (["data_processing", "finance", "general"].includes(toolSet)) {
    context += SUBAGENT_CONTEXT_DATA;
  }

  return context + "\n---\n\n## YOUR TASK\n\n" + taskDescription;
}

// ---------------------------------------------------------------------------
// System prompt — base only; proxy injects workspace files + identity context
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "You are a helpful personal assistant. You are friendly, concise, and knowledgeable. " +
  "You help users with a wide range of tasks. Keep responses concise unless the user asks " +
  "for detail. If you don't know something, say so honestly. You are accessed through " +
  "messaging channels (Telegram, Slack). Keep responses appropriate for chat-style messaging.\n\n" +
  "NEVER expose internal details to users (context windows, token limits, tool names, " +
  "retry logic, API errors, S3 buckets, [SEND_FILE] markers). If something fails, retry " +
  "silently or say 'Let me try a different approach' without technical details.\n\n" +
  "Your capabilities:\n" +
  "- **Web search**: Search the web for current information using web_search\n" +
  "- **Web fetch**: Read any web page content using web_fetch\n" +
  "- **File storage**: Read, write, list, and delete files in user's persistent S3 storage\n" +
  "- **Scheduling**: Create, list, update, and delete recurring cron schedules via EventBridge\n" +
  "- **Code execution**: Run bash commands, Python scripts, Node.js scripts via exec\n" +
  "- **File reading**: Read local files created by exec (e.g. /tmp/output.csv)\n" +
  "- **Sub-agents**: Spawn parallel sub-agents for complex multi-step tasks\n\n" +
  "NEVER share local filesystem paths (like /root/... or /tmp/...) with users. " +
  "NEVER generate presigned S3 URLs, S3 URIs (s3://...), or any download links. " +
  "The ONLY way to deliver files is [SEND_FILE:filename] in your response text. " +
  "Always use the file storage tools and refer to files by filename only.\n\n" +
  "When users ask for reminders, scheduled tasks, or recurring actions, use the scheduling tools. " +
  "Always ask for timezone if not known.";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "exec",
      description:
        "Execute a bash command. Use for running Python scripts, Node.js scripts, shell commands, " +
        "generating files (PDFs, charts, Excel), data processing, Puppeteer web scraping, etc. " +
        "Working directory is /tmp. Output is captured and returned. Max 2 minutes timeout. " +
        "For large file content, write to /tmp/ first, then use write_user_file to persist.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute (e.g. 'python3 /tmp/script.py', 'ls -la /tmp')",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a local file's contents. Use to read files created by exec (in /tmp/), " +
        "or configuration files. Returns the file content as text.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute file path to read (e.g. '/tmp/output.csv', '/tmp/report.html')",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_user_file",
      description:
        "Read a file from the user's personal S3 storage. Returns the file contents.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "The filename to read (e.g. 'notes.md', 'todo.txt')",
          },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_user_file",
      description:
        "Write content to a file in the user's personal S3 storage. Creates or overwrites. " +
        "For large files generated by exec, use --file flag: write content to /tmp/ via exec, " +
        "then write_user_file with file_path pointing to the local file.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "The filename to write (e.g. 'notes.md', 'report.pdf')",
          },
          content: {
            type: "string",
            description: "The text content to write (for small files). Omit if using file_path.",
          },
          file_path: {
            type: "string",
            description: "Local file path to upload (e.g. '/tmp/chart.png'). Use for binary/large files created by exec.",
          },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_user_files",
      description:
        "List all files in the user's personal S3 storage. Returns filenames and sizes.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_user_file",
      description: "Delete a file from the user's personal S3 storage.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "The filename to delete",
          },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_schedule",
      description:
        "Create a recurring cron schedule. Use for reminders, scheduled tasks, or recurring actions. " +
        "Cron expressions use EventBridge format: cron(minutes hours day-of-month month day-of-week year). " +
        "Examples: cron(0 9 * * ? *) = daily at 9am, cron(0 17 ? * MON-FRI *) = weekdays at 5pm.",
      parameters: {
        type: "object",
        properties: {
          cron_expression: {
            type: "string",
            description: "EventBridge cron or rate expression",
          },
          timezone: {
            type: "string",
            description: "IANA timezone, e.g. 'Europe/Madrid', 'America/New_York', 'UTC'",
          },
          message: {
            type: "string",
            description: "The message to deliver at each scheduled time",
          },
          schedule_name: {
            type: "string",
            description: "Optional human-friendly name for the schedule",
          },
        },
        required: ["cron_expression", "timezone", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_schedules",
      description: "List all cron schedules for the current user.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_schedule",
      description: "Update an existing cron schedule.",
      parameters: {
        type: "object",
        properties: {
          schedule_id: { type: "string", description: "Schedule ID (8-char hex)" },
          expression: { type: "string", description: "New cron/rate expression" },
          timezone: { type: "string", description: "New IANA timezone" },
          message: { type: "string", description: "New message" },
          name: { type: "string", description: "New name" },
          enable: { type: "boolean", description: "Enable schedule" },
          disable: { type: "boolean", description: "Disable schedule" },
        },
        required: ["schedule_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_schedule",
      description: "Delete a cron schedule permanently.",
      parameters: {
        type: "object",
        properties: {
          schedule_id: { type: "string", description: "Schedule ID (8-char hex)" },
        },
        required: ["schedule_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a web page and return its content as plain text. " +
        "Uses Lightpanda headless browser for JS rendering when available, " +
        "falls back to basic HTTP. For complex scraping, use exec with Puppeteer instead.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full URL to fetch (must start with http:// or https://)",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_subagents",
      description:
        "Spawn one or more specialized sub-agents to work on tasks in parallel. " +
        "Each sub-agent runs independently with its own Bedrock conversation loop. " +
        "Use for complex multi-step tasks that benefit from parallel execution. " +
        "Sub-agents have access to: exec, web_fetch, web_search, read_file, and user file tools. " +
        "Results from all sub-agents are combined and returned.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "Array of tasks to run in parallel",
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: "Detailed instructions for the sub-agent. Be specific about what to do and what to return.",
                },
                tool_set: {
                  type: "string",
                  enum: ["web_scraping", "finance", "research", "data_processing", "general"],
                  description: "Tool set specialization for this sub-agent",
                },
              },
              required: ["description"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },
];

// Sub-agent tool sets — subsets of the main tools
const SUBAGENT_TOOL_SETS = {
  web_scraping: ["exec", "web_fetch", "web_search", "read_file", "read_user_file", "write_user_file"],
  finance: ["exec", "web_fetch", "web_search", "read_file", "read_user_file", "write_user_file"],
  research: ["exec", "web_fetch", "web_search", "read_file", "read_user_file", "write_user_file"],
  data_processing: ["exec", "read_file", "read_user_file", "write_user_file", "list_user_files"],
  general: ["exec", "web_fetch", "web_search", "read_file", "read_user_file", "write_user_file", "list_user_files"],
};

// ---------------------------------------------------------------------------
// Tool environment and script map (shared with lightweight-agent.js)
// ---------------------------------------------------------------------------

const TOOL_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME || "/root",
  NODE_PATH: process.env.NODE_PATH || "/app/node_modules",
  NODE_OPTIONS: process.env.NODE_OPTIONS || "",
  AWS_REGION: process.env.AWS_REGION || "us-west-2",
  S3_USER_FILES_BUCKET: process.env.S3_USER_FILES_BUCKET || "",
  EVENTBRIDGE_SCHEDULE_GROUP: process.env.EVENTBRIDGE_SCHEDULE_GROUP || "",
  CRON_LAMBDA_ARN: process.env.CRON_LAMBDA_ARN || "",
  EVENTBRIDGE_ROLE_ARN: process.env.EVENTBRIDGE_ROLE_ARN || "",
  IDENTITY_TABLE_NAME: process.env.IDENTITY_TABLE_NAME || "",
};

// Mutable: updated by setExecEnv() when scoped credentials are available
let execEnv = { ...TOOL_ENV };

const SCRIPT_MAP = {
  read_user_file: "/skills/s3-user-files/read.js",
  write_user_file: "/skills/s3-user-files/write.js",
  list_user_files: "/skills/s3-user-files/list.js",
  delete_user_file: "/skills/s3-user-files/delete.js",
  create_schedule: "/skills/eventbridge-cron/create.js",
  list_schedules: "/skills/eventbridge-cron/list.js",
  update_schedule: "/skills/eventbridge-cron/update.js",
  delete_schedule: "/skills/eventbridge-cron/delete.js",
};

// ---------------------------------------------------------------------------
// Conversation history — persists across chat() calls within same container
// ---------------------------------------------------------------------------

const conversationHistory = [];

/**
 * Estimate character count of the conversation history.
 * Rough proxy for token count (4 chars ~ 1 token).
 */
function estimateHistorySize() {
  let size = 0;
  for (const msg of conversationHistory) {
    if (typeof msg.content === "string") {
      size += msg.content.length;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        size += (tc.function?.arguments || "").length;
        size += (tc.function?.name || "").length;
      }
    }
  }
  return size;
}

/**
 * Trim conversation history to stay within context limits.
 * Keeps: system prompt (index 0) + most recent messages.
 * Removes: oldest user/assistant/tool pairs after system prompt.
 */
function trimHistory() {
  while (
    conversationHistory.length > MIN_KEEP_MESSAGES &&
    estimateHistorySize() > MAX_CONTEXT_CHARS
  ) {
    // Remove the message right after system prompt (index 1)
    conversationHistory.splice(1, 1);
    console.log(`[agent] Trimmed history — now ${conversationHistory.length} messages, ~${estimateHistorySize()} chars`);
  }
}

/**
 * Reset conversation history (e.g. on explicit user request).
 */
function resetHistory() {
  conversationHistory.length = 0;
}

// ---------------------------------------------------------------------------
// SSRF prevention (reused from lightweight-agent.js)
// ---------------------------------------------------------------------------

const BLOCKED_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./, /^fc00:/i, /^fe80:/i, /^::1$/, /^fd/i, /^fd00:0*ec2:/i,
  /^::ffff:127\./i, /^::ffff:10\./i, /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
  /^::ffff:192\.168\./i, /^::ffff:169\.254\./i, /^::ffff:0\./i,
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "metadata.google.internal", "metadata.internal", "instance-data",
]);

function validateUrlSafety(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "URL is required";
  let parsed;
  try { parsed = new URL(urlStr); } catch { return "Invalid URL format"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return `Unsupported protocol: ${parsed.protocol}`;
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) return `Blocked hostname: ${hostname}`;
  for (const pattern of BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) return `Blocked IP address: ${hostname}`;
  }
  return null;
}

async function validateResolvedIps(hostname) {
  const dns = require("dns").promises;
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(addr.address))
          return `Blocked resolved IP: ${addr.address} for hostname ${hostname}`;
      }
    }
  } catch (err) {
    return `DNS resolution failed: ${err.message}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML stripping (reused from lightweight-agent.js)
// ---------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/\s*script[^>]*>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/\s*style[^>]*>/gi, " ");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/\s*noscript[^>]*>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Execute a bash command with timeout and output capture.
 */
function executeExec(command) {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      timeout: EXEC_TIMEOUT_MS,
      cwd: "/tmp",
      env: execEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputSize = 0;
    const MAX_OUTPUT = 2 * 1024 * 1024; // 2MB

    proc.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= MAX_OUTPUT) stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= MAX_OUTPUT) stderr += chunk;
    });

    proc.on("close", (code, signal) => {
      let output = stdout;
      if (stderr.trim()) {
        output += (output ? "\n" : "") + "STDERR: " + stderr;
      }
      if (code !== 0 && code !== null) {
        output += `\n[Exit code: ${code}]`;
      }
      if (signal) {
        output += `\n[Killed by signal: ${signal}]`;
      }
      if (outputSize > MAX_OUTPUT) {
        output += "\n[Output truncated — exceeded 2MB]";
      }
      const result = output.substring(0, MAX_TOOL_RESULT_CHARS) || "(no output)";
      resolve(result);
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

/**
 * Read a local file.
 */
function executeReadFile(filePath) {
  const fs = require("fs");
  return new Promise((resolve) => {
    // Basic path validation — allow /tmp and /root (workspace)
    const allowed = ["/tmp", "/root", "/app", "/skills"];
    const normalized = require("path").resolve(filePath);
    if (!allowed.some((prefix) => normalized.startsWith(prefix))) {
      resolve(`Error: Access denied — can only read files under /tmp, /root, /app, /skills`);
      return;
    }
    fs.readFile(normalized, (err, data) => {
      if (err) {
        resolve(`Error: ${err.message}`);
        return;
      }
      // Try text, fall back to base64 for binary
      const text = data.toString("utf-8");
      if (text.includes("\0")) {
        resolve(`[Binary file, ${data.length} bytes — use exec to process]`);
      } else {
        resolve(text.substring(0, MAX_TOOL_RESULT_CHARS) || "(empty file)");
      }
    });
  });
}

/**
 * Write user file — supports both inline content and --file flag.
 */
function executeWriteUserFile(args, userId) {
  // If file_path is specified, use --file flag
  if (args.file_path) {
    return new Promise((resolve) => {
      execFile(
        "node",
        [SCRIPT_MAP.write_user_file, userId, args.filename || "", `--file=${args.file_path}`],
        { env: TOOL_ENV, timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolve(`Error: ${stderr?.trim() || error.message}`);
            return;
          }
          resolve(stdout || "(no output)");
        },
      );
    });
  }

  // Inline content via stdin (avoids ARG_MAX)
  const content = args.content || "";
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [SCRIPT_MAP.write_user_file, userId, args.filename || "", "--stdin"],
      { env: TOOL_ENV, stdio: ["pipe", "pipe", "pipe"], timeout: TOOL_TIMEOUT_MS },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(`Error: ${stderr.trim() || `Process exited with code ${code}`}`);
        return;
      }
      resolve(stdout || "(no output)");
    });
    child.on("error", (err) => resolve(`Error: ${err.message}`));
    child.stdin.write(content);
    child.stdin.end();
  });
}

// Web tools (reused from lightweight-agent.js)

async function executeWebFetch(url, depth = 0) {
  if (depth > MAX_REDIRECTS) return "Error: Too many redirects";
  const validationError = validateUrlSafety(url);
  if (validationError) return `Error: ${validationError}`;
  const parsed = new URL(url);
  const ipError = await validateResolvedIps(parsed.hostname);
  if (ipError) return `Error: ${ipError}`;

  // Try Lightpanda first
  try {
    const result = await lightpandaFetch.fetchWithLightpanda(url, { timeout: WEB_FETCH_TIMEOUT_MS });
    if (result && result.text && result.text.trim().length > 50) {
      console.log(`[agent] web_fetch via Lightpanda: ${url} (${result.text.length} chars)`);
      return result.text;
    }
    if (result) console.log(`[agent] Lightpanda short content (${(result.text || "").length} chars) — falling back`);
  } catch (err) {
    console.log(`[agent] Lightpanda failed, falling back: ${err.message}`);
  }

  return _basicHttpFetch(url, depth);
}

function _basicHttpFetch(url, depth = 0) {
  if (depth > MAX_REDIRECTS) return Promise.resolve("Error: Too many redirects");
  const validationError = validateUrlSafety(url);
  if (validationError) return Promise.resolve(`Error: ${validationError}`);

  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, {
      timeout: WEB_FETCH_TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        const redirectError = validateUrlSafety(redirectUrl);
        if (redirectError) { resolve(`Error: Redirect blocked — ${redirectError}`); return; }
        res.resume();
        resolve(_basicHttpFetch(redirectUrl, depth + 1));
        return;
      }
      if (res.statusCode >= 400) { res.resume(); resolve(`Error: HTTP ${res.statusCode}`); return; }

      let data = "";
      let bytes = 0;
      let resolved = false;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > WEB_FETCH_MAX_BYTES) {
          if (!resolved) {
            resolved = true;
            resolve(stripHtml(data).substring(0, WEB_FETCH_MAX_TEXT) + "\n\n[Truncated]");
          }
          res.destroy();
          return;
        }
        data += chunk;
      });
      res.on("end", () => { if (!resolved) { resolved = true; resolve(stripHtml(data).substring(0, WEB_FETCH_MAX_TEXT) || "(empty page)"); } });
      res.on("error", (err) => { if (!resolved) { resolved = true; resolve(`Error: ${err.message}`); } });
    });
    req.on("error", (err) => resolve(`Error: ${err.message}`));
    req.on("timeout", () => { req.destroy(); resolve("Error: Request timed out"); });
  });
}

function parseSearchResults(html) {
  if (!html) return "No results found.";
  const results = [];
  const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let match;
  while ((match = resultPattern.exec(html)) !== null) {
    let url = match[1];
    try {
      const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
    } catch {}
    links.push({ url, title: stripHtml(match[2]) });
  }
  const snippets = [];
  while ((match = snippetPattern.exec(html)) !== null) snippets.push(stripHtml(match[1]));
  for (let i = 0; i < Math.min(links.length, WEB_SEARCH_MAX_RESULTS); i++) {
    const entry = `${i + 1}. ${links[i].title}\n   ${links[i].url}`;
    results.push(entry + (snippets[i] ? `\n   ${snippets[i]}` : ""));
  }
  return results.length > 0 ? results.join("\n\n") : "No results found.";
}

async function executeWebSearch(query) {
  if (!query || typeof query !== "string" || !query.trim()) return "Error: Search query is required";
  const trimmedQuery = query.trim().substring(0, MAX_SEARCH_QUERY_LENGTH);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmedQuery)}`;
  return new Promise((resolve) => {
    const req = https.get(searchUrl, {
      timeout: WEB_FETCH_TIMEOUT_MS,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentBot/1.0)", Accept: "text/html" },
    }, (res) => {
      if (res.statusCode >= 400) { res.resume(); resolve(`Error: HTTP ${res.statusCode}`); return; }
      let data = "";
      let bytes = 0;
      let resolved = false;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > WEB_FETCH_MAX_BYTES) {
          if (!resolved) { resolved = true; resolve(parseSearchResults(data)); }
          res.destroy();
          return;
        }
        data += chunk;
      });
      res.on("end", () => { if (!resolved) { resolved = true; resolve(parseSearchResults(data)); } });
      res.on("error", (err) => { if (!resolved) { resolved = true; resolve(`Error: ${err.message}`); } });
    });
    req.on("error", (err) => resolve(`Error: ${err.message}`));
    req.on("timeout", () => { req.destroy(); resolve("Error: Search timed out"); });
  });
}

// Skill script execution (reused pattern from lightweight-agent.js)

function buildToolArgs(toolName, args, userId) {
  const script = SCRIPT_MAP[toolName];
  if (!script) return null;
  switch (toolName) {
    case "read_user_file": return [script, userId, args.filename || ""];
    case "list_user_files": return [script, userId];
    case "delete_user_file": return [script, userId, args.filename || ""];
    case "create_schedule": {
      const result = [script, userId, args.cron_expression || "", args.timezone || "", args.message || ""];
      if (args.schedule_name) result.push("", "", args.schedule_name);
      return result;
    }
    case "list_schedules": return [script, userId];
    case "update_schedule": {
      const result = [script, userId, args.schedule_id || ""];
      if (args.expression) result.push("--expression", args.expression);
      if (args.timezone) result.push("--timezone", args.timezone);
      if (args.message) result.push("--message", args.message);
      if (args.name) result.push("--name", args.name);
      if (args.enable === true && args.disable !== true) result.push("--enable");
      if (args.disable === true && args.enable !== true) result.push("--disable");
      return result;
    }
    case "delete_schedule": return [script, userId, args.schedule_id || ""];
    default: return null;
  }
}

function executeSkillScript(toolName, args, userId) {
  const scriptArgs = buildToolArgs(toolName, args, userId);
  if (!scriptArgs) return Promise.resolve(`Error: Unknown tool '${toolName}'`);
  return new Promise((resolve) => {
    execFile("node", scriptArgs, {
      timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: TOOL_ENV,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error: ${stderr?.trim() || error.message}`);
        return;
      }
      resolve(stdout || "(no output)");
    });
  });
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a tool by name.
 * @param {string} toolName
 * @param {object} args - parsed tool arguments
 * @param {string} userId - namespace format (telegram_123456)
 * @returns {Promise<string>}
 */
async function executeTool(toolName, args, userId) {
  switch (toolName) {
    case "exec":
      return executeExec(args.command || "echo 'No command provided'");
    case "read_file":
      return executeReadFile(args.path || "");
    case "write_user_file":
      return executeWriteUserFile(args, userId);
    case "web_fetch":
      return executeWebFetch(args.url);
    case "web_search":
      return executeWebSearch(args.query);
    case "spawn_subagents":
      return executeSpawnSubagents(args, userId);
    // Skill scripts
    case "read_user_file":
    case "list_user_files":
    case "delete_user_file":
    case "create_schedule":
    case "list_schedules":
    case "update_schedule":
    case "delete_schedule":
      return executeSkillScript(toolName, args, userId);
    default:
      return `Error: Unknown tool '${toolName}'`;
  }
}

// ---------------------------------------------------------------------------
// Sub-agent execution (fork-join pattern)
// ---------------------------------------------------------------------------

/**
 * Run a single sub-agent: independent Bedrock conversation loop.
 */
async function runSubagent(taskDescription, toolNames, userId, deadline, toolSet = "general", agentIndex = 0) {
  const subTools = TOOLS.filter(
    (t) => toolNames.includes(t.function.name) && t.function.name !== "spawn_subagents", // no recursive spawning
  );

  const systemPrompt = buildSubagentSystemPrompt(taskDescription, toolSet);

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: "Execute the task described in your system prompt. Return your results clearly.",
    },
  ];

  // Update status tracker
  if (subagentStatus.agents[agentIndex]) {
    subagentStatus.agents[agentIndex].status = "running";
  }

  for (let i = 0; i < MAX_SUBAGENT_ITERATIONS; i++) {
    // Update iteration in status tracker
    if (subagentStatus.agents[agentIndex]) {
      subagentStatus.agents[agentIndex].iteration = i + 1;
    }

    if (Date.now() > deadline) {
      console.warn(`[subagent] Deadline exceeded at iteration ${i + 1}`);
      if (subagentStatus.agents[agentIndex]) {
        subagentStatus.agents[agentIndex].status = "deadline_exceeded";
      }
      break;
    }

    let response;
    try {
      response = await callProxy(messages, { model: SUBAGENT_MODEL, tools: subTools });
    } catch (err) {
      console.error(`[subagent] Proxy call failed: ${err.message}`);
      if (subagentStatus.agents[agentIndex]) {
        subagentStatus.agents[agentIndex].status = "error";
      }
      return `Sub-agent error: ${err.message}`;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      if (subagentStatus.agents[agentIndex]) {
        subagentStatus.agents[agentIndex].status = "completed";
      }
      return "Sub-agent received no response";
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      if (subagentStatus.agents[agentIndex]) {
        subagentStatus.agents[agentIndex].status = "completed";
      }
      return assistantMessage.content || "(no output from sub-agent)";
    }

    for (const toolCall of toolCalls) {
      const fnName = toolCall.function?.name;
      let fnArgs;
      try {
        fnArgs = typeof toolCall.function?.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function?.arguments || {};
      } catch {
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: "Error: Invalid JSON arguments" });
        continue;
      }
      // Update status tracker with current tool
      if (subagentStatus.agents[agentIndex]) {
        subagentStatus.agents[agentIndex].lastTool = fnName;
        subagentStatus.agents[agentIndex].lastToolArg =
          fnName === "web_fetch" ? (fnArgs.url || "").slice(0, 100) :
          fnName === "exec" ? (fnArgs.command || "").slice(0, 80) :
          fnName === "web_search" ? (fnArgs.query || "").slice(0, 80) :
          "";
      }
      console.log(`[subagent] Tool: ${fnName}`);
      const result = await executeTool(fnName, fnArgs, userId);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: (result || "").substring(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }
  if (subagentStatus.agents[agentIndex]) {
    subagentStatus.agents[agentIndex].status = "iteration_limit";
  }
  return "Sub-agent reached iteration limit";
}

/**
 * Spawn multiple sub-agents in parallel (fork-join pattern).
 */
async function executeSpawnSubagents(args, userId) {
  const tasks = args.tasks || [];
  if (tasks.length === 0) return "Error: No tasks provided";
  if (tasks.length > MAX_CONCURRENT_SUBAGENTS) {
    return `Error: Maximum ${MAX_CONCURRENT_SUBAGENTS} concurrent sub-agents`;
  }

  const deadline = Date.now() + 3600000; // 1 hour
  console.log(`[agent] Spawning ${tasks.length} sub-agent(s)`);

  // Initialize sub-agent status tracker
  subagentStatus.active = true;
  subagentStatus.startedAt = Date.now();
  subagentStatus.mainTask = tasks.map((t) => t.description?.slice(0, 100) || "").join("; ");
  subagentStatus.agents = tasks.map((task, i) => ({
    id: i + 1,
    toolSet: task.tool_set || "general",
    description: (task.description || "").slice(0, 120),
    iteration: 0,
    maxIterations: MAX_SUBAGENT_ITERATIONS,
    lastTool: "",
    lastToolArg: "",
    status: "starting",
  }));

  const promises = tasks.map((task, i) => {
    const toolSet = task.tool_set || "general";
    const toolNames = SUBAGENT_TOOL_SETS[toolSet] || SUBAGENT_TOOL_SETS.general;
    console.log(`[agent] Sub-agent ${i + 1}: ${toolSet} (${toolNames.length} tools)`);
    return runSubagent(task.description, toolNames, userId, deadline, toolSet, i);
  });

  try {
    const results = await Promise.allSettled(promises);

    const output = results.map((r, i) => {
      const status = r.status === "fulfilled" ? "completed" : "failed";
      const value = r.status === "fulfilled" ? r.value : r.reason?.message || "Unknown error";
      return `--- Sub-agent ${i + 1} (${status}) ---\n${value}`;
    });

    return output.join("\n\n");
  } finally {
    // Clear status tracker
    subagentStatus.active = false;
    subagentStatus.agents = [];
    subagentStatus.mainTask = "";
  }
}

// ---------------------------------------------------------------------------
// Proxy call
// ---------------------------------------------------------------------------

/**
 * Make a chat completion request to the proxy.
 * @param {Array} messages - conversation messages
 * @param {object} options - { model, tools, stream }
 */
function callProxy(messages, options = {}) {
  const payload = JSON.stringify({
    model: options.model || "bedrock-agentcore",
    messages,
    tools: options.tools || TOOLS,
    stream: options.stream || false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(PROXY_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Proxy response parse error: ${e.message}`));
        }
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxy request timed out")); });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

/**
 * Process a user message through the agent loop.
 *
 * @param {string} userMessage - The user's message text
 * @param {string} actorId - The user's actor ID (e.g. "telegram:123456")
 * @param {number} deadlineMs - Absolute timestamp deadline (0 = no deadline)
 * @param {Function} onDelta - Optional callback for streaming text deltas: onDelta(accumulatedText)
 * @returns {Promise<string>} - The assistant's final text response
 */
async function chat(userMessage, actorId, deadlineMs = 0, onDelta = null) {
  const namespace = actorId.replace(/:/g, "_");

  // Initialize conversation if first message
  if (conversationHistory.length === 0) {
    conversationHistory.push({ role: "system", content: SYSTEM_PROMPT });
  }

  // Add user message
  conversationHistory.push({ role: "user", content: userMessage });

  // Trim if approaching context limit
  trimHistory();

  let lastAssistantText = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (deadlineMs > 0 && Date.now() > deadlineMs) {
      console.warn(`[agent] Deadline exceeded at iteration ${i + 1}`);
      break;
    }
    console.log(`[agent] Iteration ${i + 1}/${MAX_ITERATIONS} (${conversationHistory.length} messages)`);

    let response;
    try {
      response = await callProxy(conversationHistory);
    } catch (err) {
      console.error(`[agent] Proxy call failed: ${err.message}`);
      return "I'm having trouble right now. Please try again in a moment.";
    }

    const choice = response.choices?.[0];
    if (!choice) {
      const errDetail = response.error?.message || JSON.stringify(response).slice(0, 300);
      console.error(`[agent] No choices in response: ${errDetail}`);
      return "I received an unexpected response. Please try again.";
    }

    const assistantMessage = choice.message;
    conversationHistory.push(assistantMessage);

    // Stream text delta to callback (for Telegram sendMessageDraft)
    if (assistantMessage.content && onDelta) {
      lastAssistantText = assistantMessage.content;
      try { onDelta(lastAssistantText); } catch {}
    }

    // If no tool calls, we're done
    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return assistantMessage.content || "I received your message but couldn't generate a response.";
    }

    // Execute tool calls
    console.log(`[agent] Executing ${toolCalls.length} tool call(s)`);
    for (const toolCall of toolCalls) {
      const fnName = toolCall.function?.name;
      let fnArgs;
      try {
        fnArgs = typeof toolCall.function?.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function?.arguments || {};
      } catch (parseErr) {
        console.error(`[agent] Tool ${fnName} arg parse error: ${parseErr.message}`);
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: Invalid JSON arguments — ${parseErr.message}. Please retry with valid JSON.`,
        });
        continue;
      }

      console.log(`[agent] Tool: ${fnName}`);
      const result = await executeTool(fnName, fnArgs, namespace);

      // Truncate large results to prevent context explosion
      const truncatedResult = (result || "").substring(0, MAX_TOOL_RESULT_CHARS);

      conversationHistory.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: truncatedResult,
      });
    }

    // Trim after tool results (they can be large)
    trimHistory();
  }

  console.warn("[agent] Max iterations reached");
  return "I ran into a processing limit. Please try rephrasing your request.";
}

// ---------------------------------------------------------------------------
// Env configuration — called by contract server after scoped creds are ready
// ---------------------------------------------------------------------------

/**
 * Update the exec environment with scoped credentials.
 * Called by agentcore-contract.js after STS credential scoping.
 */
function setExecEnv(env) {
  execEnv = { ...TOOL_ENV, ...env };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  chat,
  resetHistory,
  setExecEnv,
  getSubagentStatus,
  // Exported for testing
  TOOLS,
  SYSTEM_PROMPT,
  TOOL_ENV,
  SCRIPT_MAP,
  executeTool,
  executeExec,
  executeReadFile,
  executeWebFetch,
  executeWebSearch,
  executeSpawnSubagents,
  buildToolArgs,
  buildSubagentSystemPrompt,
  callProxy,
  conversationHistory,
  trimHistory,
  estimateHistorySize,
  stripHtml,
  parseSearchResults,
  validateUrlSafety,
  validateResolvedIps,
  subagentStatus,
  // Constants for testing
  MAX_ITERATIONS,
  MAX_SUBAGENT_ITERATIONS,
  MAX_CONTEXT_CHARS,
  MIN_KEEP_MESSAGES,
  MAX_TOOL_RESULT_CHARS,
  MAX_CONCURRENT_SUBAGENTS,
  SUBAGENT_TOOL_SETS,
};
