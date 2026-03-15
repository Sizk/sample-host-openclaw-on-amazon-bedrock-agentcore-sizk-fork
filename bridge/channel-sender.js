/**
 * Channel Sender — Direct Telegram/Slack message delivery from the container.
 *
 * Ported from the cron Lambda's deliver_response() (lambda/cron/index.py).
 * Used by the contract server in async mode to send responses directly to
 * channels, decoupling response delivery from the Router Lambda timeout.
 */

const http = require("http");
const https = require("https");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "eu-west-1";
const USER_FILES_BUCKET = process.env.S3_USER_FILES_BUCKET || "";

// Reuse connections across requests
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * Make an HTTPS request and return { statusCode, body }.
 */
function httpsRequest(url, options, bodyData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, agent: httpsAgent }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timeout"));
    });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML (ported from cron Lambda's _markdown_to_telegram_html)
// ---------------------------------------------------------------------------

function markdownToTelegramHtml(text) {
  if (!text) return text;

  const placeholders = [];
  const placeholder = (content) => {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  };

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 1. Extract fenced code blocks: ```lang\n...\n```
  text = text.replace(/```\w*\n?([\s\S]*?)```/g, (_, code) =>
    placeholder(`<pre>${escapeHtml(code)}</pre>`),
  );

  // 2. Extract markdown tables and render as monospace <pre> blocks
  text = text.replace(/(?:^\|.+\|[ \t]*$\n?){2,}/gm, (match) => {
    const lines = match.trim().split("\n");
    const rows = [];
    for (const line of lines) {
      const stripped = line.trim().replace(/^\||\|$/g, "").trim();
      if (stripped && !/^[\s|:-]+$/.test(stripped)) {
        const cells = line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        rows.push(cells);
      }
    }
    if (!rows.length) return match;
    const colCount = Math.max(...rows.map((r) => r.length));
    const widths = new Array(colCount).fill(0);
    for (const row of rows) {
      for (let i = 0; i < row.length && i < colCount; i++) {
        const plain = row[i].replace(/\*\*(.+?)\*\*/g, "$1");
        widths[i] = Math.max(widths[i], plain.length);
      }
    }
    const formatted = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const parts = [];
      for (let i = 0; i < colCount; i++) {
        const cell = ri < rows.length && i < rows[ri].length ? rows[ri][i] : "";
        const plain = cell.replace(/\*\*(.+?)\*\*/g, "$1");
        const pad = widths[i] - plain.length + cell.length;
        parts.push(cell.padEnd(pad));
      }
      formatted.push(parts.join("  "));
      if (ri === 0) {
        formatted.push(widths.map((w) => "─".repeat(w)).join("  "));
      }
    }
    let tableText = formatted.join("\n");
    tableText = escapeHtml(tableText);
    tableText = tableText.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    return placeholder(`<pre>${tableText}</pre>`);
  });

  // 3. Extract inline code: `text`
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    placeholder(`<code>${escapeHtml(code)}</code>`),
  );

  // 4. HTML-escape remaining text
  text = escapeHtml(text);

  // 5. Convert markdown patterns to HTML
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<i>$1</i>");
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");
  text = text.replace(/^[-=*]{3,}\s*$/gm, "———");

  // 6. Re-insert placeholders
  for (let i = 0; i < placeholders.length; i++) {
    text = text.replace(`\x00PH${i}\x00`, placeholders[i]);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Extract text from content blocks (recursive unwrap)
// ---------------------------------------------------------------------------

function extractTextFromContentBlocks(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (let i = 0; i < 10; i++) {
    const stripped = result.trim();
    if (!stripped.startsWith("[") || !stripped.endsWith("]")) break;
    // Sanitize control characters that are invalid in JSON strings but may
    // appear in bridge responses (literal newlines, tabs, etc.).
    // Matches Python's json.JSONDecoder(strict=False) behavior.
    // Only sanitize within JSON string values to avoid corrupting content.
    const sanitized = stripped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    // Replace literal newlines/tabs with JSON escapes for parse attempt
    const forParse = sanitized
      .replace(/\t/g, "\\t")
      .replace(/\r\n/g, "\\n")
      .replace(/\r/g, "\\n")
      .replace(/\n/g, "\\n");
    let parsed = false;
    try {
      // Try strict parse first with escaped version
      let blocks;
      try {
        blocks = JSON.parse(forParse);
      } catch {
        // Fall back to parsing the sanitized version (allows literal newlines in strings)
        blocks = JSON.parse(sanitized);
      }
      if (Array.isArray(blocks) && blocks.length > 0) {
        const parts = blocks
          .filter((b) => typeof b === "object" && b && b.type === "text")
          .map((b) => b.text || "");
        if (parts.length > 0) {
          const unwrapped = parts.join("");
          if (unwrapped === result) break;
          result = unwrapped;
          parsed = true;
        }
      }
    } catch (e) {
      // Only log at debug level — parse failures are expected during streaming
      if (stripped.length > 50) {
        console.warn(
          `[channel-sender] Content block JSON.parse failed: ${e.message} | len=${stripped.length} start: ${stripped.slice(0, 100)}`,
        );
      }
    }
    if (parsed) continue;

    // Regex fallback: strip [{"type":"text","text":"..."}] wrapper (complete or partial)
    // During streaming, deltas may be incomplete JSON — strip the prefix anyway.
    // Guard: only apply if the prefix is a content block pattern, not user content
    // that happens to start with [{"type
    const prefixMatch = stripped.match(
      /^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/,
    );
    if (prefixMatch) {
      let inner = stripped.slice(prefixMatch[0].length);
      // Strip closing "}] if present (complete content block)
      if (inner.endsWith('"}]')) inner = inner.slice(0, -3);
      // Unescape JSON string escapes
      // Unescape order matters: \\\\ -> \\ must run LAST to avoid
      // interfering with other escape sequences like \\" -> "
      const unescaped = inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");  // Must be last
      if (unescaped !== result) {
        console.log(
          `[channel-sender] Content blocks unwrapped via regex fallback (${unescaped.length} chars)`,
        );
        result = unescaped;
        continue;
      }
    }
    break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function sendTelegramMessage(chatId, text, token) {
  if (!token) {
    console.error("[channel-sender] No Telegram token available");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Try HTML first (converted from Markdown)
  const htmlText = markdownToTelegramHtml(text);
  try {
    const { statusCode, body } = await httpsRequest(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      JSON.stringify({ chat_id: chatId, text: htmlText, parse_mode: "HTML" }),
    );
    if (statusCode >= 200 && statusCode < 300) return;
    console.warn(
      `[channel-sender] Telegram HTML send failed (${statusCode}): ${body.slice(0, 200)} — retrying plain`,
    );
  } catch (e) {
    console.warn(
      `[channel-sender] Telegram HTML send error: ${e.message} — retrying plain`,
    );
  }

  // Fallback: plain text
  try {
    await httpsRequest(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      JSON.stringify({ chat_id: chatId, text }),
    );
  } catch (e) {
    console.error(
      `[channel-sender] Failed to send Telegram message to ${chatId}: ${e.message}`,
    );
  }
}

/**
 * Send a streaming draft to Telegram via sendMessageDraft (Bot API 9.5).
 *
 * The draft_id must be a non-zero integer. Same draft_id = animated update
 * of the same draft bubble. The last draft sent becomes the final visible message.
 *
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} text - Accumulated message text so far
 * @param {string} token - Bot API token
 * @param {string|number} draftId - Unique draft session ID (same for all updates in one stream)
 * @param {string} [parseMode] - Optional parse_mode ("HTML" for final formatted message)
 */
async function sendTelegramDraft(chatId, text, token, draftId, parseMode) {
  if (!token || !draftId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessageDraft`;
  const payload = {
    chat_id: chatId,
    draft_id: Number(draftId),
    text,
  };
  if (parseMode) payload.parse_mode = parseMode;
  try {
    const { statusCode, body } = await httpsRequest(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      JSON.stringify(payload),
    );
    if (statusCode >= 400) {
      console.warn(
        `[channel-sender] sendMessageDraft failed (${statusCode}): ${body.slice(0, 200)}`,
      );
    }
  } catch (e) {
    console.warn(`[channel-sender] sendMessageDraft error: ${e.message}`);
  }
}

async function sendTelegramTyping(chatId, token) {
  if (!token) return;
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  try {
    await httpsRequest(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      JSON.stringify({ chat_id: chatId, action: "typing" }),
    );
  } catch {
    // Best effort
  }
}

async function sendTelegramDocument(chatId, fileBytes, filename, token) {
  if (!token) {
    console.error("[channel-sender] No Telegram token available");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const boundary = require("crypto").randomUUID().replace(/-/g, "");

  const parts = [];
  // chat_id field
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`,
  );
  // document field (binary)
  const docHeader = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;

  const payload = Buffer.concat([
    Buffer.from(parts[0] + "\r\n"),
    Buffer.from(docHeader),
    Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  try {
    await httpsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
    }, payload);
    console.log(
      `[channel-sender] Telegram document sent: ${filename} (${fileBytes.length} bytes)`,
    );
  } catch (e) {
    console.error(
      `[channel-sender] Failed to send Telegram document ${filename}: ${e.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Slack API
// ---------------------------------------------------------------------------

async function sendSlackMessage(channelId, text, botToken) {
  if (!botToken) {
    console.error("[channel-sender] No Slack bot token available");
    return;
  }
  try {
    const { statusCode, body } = await httpsRequest(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
      },
      JSON.stringify({ channel: channelId, text }),
    );
    if (statusCode >= 200 && statusCode < 300) {
      const data = JSON.parse(body);
      if (!data.ok) {
        console.error(
          `[channel-sender] Slack chat.postMessage error: ${data.error}`,
        );
      }
    }
  } catch (e) {
    console.error(
      `[channel-sender] Failed to send Slack message to ${channelId}: ${e.message}`,
    );
  }
}

async function sendSlackFile(channelId, fileBytes, filename, botToken) {
  if (!botToken) {
    console.error("[channel-sender] No Slack bot token available");
    return;
  }
  const authHeaders = { Authorization: `Bearer ${botToken}` };

  // Step 1: get upload URL
  let uploadUrl, fileId;
  try {
    const encodedFilename = encodeURIComponent(filename);
    const { body } = await httpsRequest(
      `https://slack.com/api/files.getUploadURLExternal?filename=${encodedFilename}&length=${fileBytes.length}`,
      { method: "GET", headers: authHeaders },
    );
    const data = JSON.parse(body);
    if (!data.ok) {
      console.error(
        `[channel-sender] Slack getUploadURLExternal error: ${data.error}`,
      );
      return;
    }
    uploadUrl = data.upload_url;
    fileId = data.file_id;
  } catch (e) {
    console.error(
      `[channel-sender] Slack getUploadURLExternal failed: ${e.message}`,
    );
    return;
  }

  // Step 2: upload file bytes
  try {
    await httpsRequest(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    }, Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes));
  } catch (e) {
    console.error(`[channel-sender] Slack file upload failed: ${e.message}`);
    return;
  }

  // Step 3: complete upload
  try {
    const { body } = await httpsRequest(
      "https://slack.com/api/files.completeUploadExternal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
      },
      JSON.stringify({
        files: [{ id: fileId, title: filename }],
        channel_id: channelId,
      }),
    );
    const data = JSON.parse(body);
    if (!data.ok) {
      console.error(
        `[channel-sender] Slack completeUploadExternal error: ${data.error}`,
      );
    } else {
      console.log(
        `[channel-sender] Slack file sent: ${filename} (${fileBytes.length} bytes)`,
      );
    }
  } catch (e) {
    console.error(
      `[channel-sender] Slack completeUploadExternal failed: ${e.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// S3 file download
// ---------------------------------------------------------------------------

let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({ region: REGION });
  }
  return s3Client;
}

async function downloadFileFromS3(s3Key) {
  if (!USER_FILES_BUCKET) {
    console.warn(
      "[channel-sender] USER_FILES_BUCKET not configured — cannot download file",
    );
    return null;
  }
  try {
    const resp = await getS3Client().send(
      new GetObjectCommand({ Bucket: USER_FILES_BUCKET, Key: s3Key }),
    );
    const chunks = [];
    for await (const chunk of resp.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    console.error(
      `[channel-sender] S3 file download failed for ${s3Key}: ${e.message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Send response files
// ---------------------------------------------------------------------------

async function sendResponseFiles(files, channel, chatId, tokens) {
  if (!files || !files.length) return;
  for (const f of files) {
    const s3Key = f.s3Key;
    const filename =
      f.filename || (s3Key ? s3Key.split("/").pop() : "file");
    const fileBytes = await downloadFileFromS3(s3Key);
    if (!fileBytes) {
      console.warn(
        `[channel-sender] Skipping file ${s3Key} — could not download from S3`,
      );
      continue;
    }
    if (channel === "telegram") {
      await sendTelegramDocument(chatId, fileBytes, filename, tokens.telegram);
    } else if (channel === "slack") {
      await sendSlackFile(chatId, fileBytes, filename, tokens.slack);
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level: deliver response to channel
// ---------------------------------------------------------------------------

async function deliverResponse(channel, chatId, text, files, tokens, draftId) {
  // Extract content blocks if wrapped
  const cleanText = extractTextFromContentBlocks(text);

  if (channel === "telegram") {
    const token = tokens.telegram;

    // ALWAYS send the final response as a real sendMessage — never rely on drafts
    // for the permanent message. Drafts are ephemeral and can vanish if HTML parsing
    // fails, leaving the user with "Deleted message". sendMessage has HTML -> plain
    // text fallback, so it ALWAYS succeeds. The streaming draft will auto-disappear
    // when the real message arrives.
    if (draftId) {
      // Clear the streaming draft by sending an empty-ish draft before the real message.
      // This prevents a brief moment where both draft and message are visible.
      await sendTelegramDraft(chatId, "...", token, draftId);
    }

    if (cleanText.length <= 4096) {
      await sendTelegramMessage(chatId, cleanText, token);
    } else {
      // Split into 4096-char chunks
      for (let i = 0; i < cleanText.length; i += 4096) {
        await sendTelegramMessage(chatId, cleanText.slice(i, i + 4096), token);
      }
    }
    await sendResponseFiles(files, channel, chatId, tokens);
  } else if (channel === "slack") {
    await sendSlackMessage(chatId, cleanText, tokens.slack);
    await sendResponseFiles(files, channel, chatId, tokens);
  } else {
    console.warn(`[channel-sender] Unknown channel type: ${channel}`);
  }
}

module.exports = {
  deliverResponse,
  sendTelegramMessage,
  sendTelegramDraft,
  sendTelegramTyping,
  sendTelegramDocument,
  sendSlackMessage,
  sendSlackFile,
  sendResponseFiles,
  downloadFileFromS3,
  markdownToTelegramHtml,
  extractTextFromContentBlocks,
};
