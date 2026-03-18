"""Router Lambda — Webhook ingestion for Telegram and Slack.

Receives webhook events via API Gateway HTTP API, resolves user identity via
DynamoDB, invokes the per-user AgentCore Runtime session, and sends responses
back to the originating channel.

Path routing:
  POST /webhook/telegram  — Telegram Bot API webhook
  POST /webhook/slack     — Slack Events API webhook
"""

import hashlib
import hmac
import json
import logging
import os
import re
import time
import uuid
from collections import deque
from urllib import request as urllib_request
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# --- Configuration ---
AGENTCORE_RUNTIME_ARN = os.environ["AGENTCORE_RUNTIME_ARN"]
AGENTCORE_QUALIFIER = os.environ["AGENTCORE_QUALIFIER"]
IDENTITY_TABLE_NAME = os.environ["IDENTITY_TABLE_NAME"]
TELEGRAM_TOKEN_SECRET_ID = os.environ.get("TELEGRAM_TOKEN_SECRET_ID", "")
SLACK_TOKEN_SECRET_ID = os.environ.get("SLACK_TOKEN_SECRET_ID", "")
WEBHOOK_SECRET_ID = os.environ.get("WEBHOOK_SECRET_ID", "")
LAMBDA_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
REGISTRATION_OPEN = os.environ.get("REGISTRATION_OPEN", "false").lower() == "true"
LAMBDA_TIMEOUT_SECONDS = int(os.environ.get("LAMBDA_TIMEOUT_SECONDS", "600"))

# --- Clients (lazy init on cold start) ---
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
identity_table = dynamodb.Table(IDENTITY_TABLE_NAME)
agentcore_client = boto3.client(
    "bedrock-agentcore",
    region_name=AWS_REGION,
    config=Config(
        # Async mode: container returns "accepted" in ~1-5s, but keep a generous
        # timeout for sync fallback (old container versions or cron Lambda reuse).
        read_timeout=60,
        connect_timeout=10,
        retries={"max_attempts": 0},
    ),
)
lambda_client = boto3.client("lambda", region_name=AWS_REGION)
secrets_client = boto3.client("secretsmanager", region_name=AWS_REGION)
s3_client = boto3.client("s3", region_name=AWS_REGION)

USER_FILES_BUCKET = os.environ.get("USER_FILES_BUCKET", "")

# --- Token cache (survives across warm invocations) ---
_token_cache = {}

BIND_CODE_TTL_SECONDS = 600  # 10 minutes

# --- Telegram update_id dedup (prevents processing duplicate webhooks) ---
# LRU-style set of recently processed update_ids. Telegram may send the same
# webhook twice under network issues even after we return 200. Without dedup,
# both async-dispatch Lambdas would process the same message.
_processed_update_ids = set()
MAX_PROCESSED_UPDATE_IDS = 1000
_processed_update_ids_deque = deque(maxlen=MAX_PROCESSED_UPDATE_IDS)  # O(1) eviction


def _get_secret(secret_id):
    """Fetch a secret value, cached for the lifetime of the Lambda container."""
    if secret_id in _token_cache:
        return _token_cache[secret_id]
    if not secret_id:
        return ""
    try:
        resp = secrets_client.get_secret_value(SecretId=secret_id)
        value = resp["SecretString"]
        _token_cache[secret_id] = value
        return value
    except Exception as e:
        logger.warning("Failed to fetch secret %s: %s", secret_id, e)
        return ""


def _get_telegram_token():
    return _get_secret(TELEGRAM_TOKEN_SECRET_ID)


def _get_slack_tokens():
    """Return (bot_token, signing_secret) tuple from Slack secret (JSON or plain string)."""
    raw = _get_secret(SLACK_TOKEN_SECRET_ID)
    if not raw:
        return "", ""
    try:
        data = json.loads(raw)
        return data.get("botToken", ""), data.get("signingSecret", "")
    except (json.JSONDecodeError, TypeError):
        return raw, ""


def _get_webhook_secret():
    return _get_secret(WEBHOOK_SECRET_ID)


# ---------------------------------------------------------------------------
# Webhook validation helpers
# ---------------------------------------------------------------------------

def validate_telegram_webhook(headers):
    """Validate Telegram webhook using X-Telegram-Bot-Api-Secret-Token header.

    Returns False (fail-closed) if no webhook secret is configured.
    """
    webhook_secret = _get_webhook_secret()
    if not webhook_secret:
        logger.error("WEBHOOK_SECRET_ID not configured — rejecting request (fail-closed)")
        return False

    token = headers.get("x-telegram-bot-api-secret-token", "")
    if not token:
        logger.warning("Telegram webhook missing X-Telegram-Bot-Api-Secret-Token header")
        return False

    if not hmac.compare_digest(token, webhook_secret):
        logger.warning("Telegram webhook secret token mismatch")
        return False

    return True


def validate_slack_webhook(headers, body):
    """Validate Slack webhook using X-Slack-Signature HMAC-SHA256 verification.

    Slack signs each request with: v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{body}")
    See: https://api.slack.com/authentication/verifying-requests-from-slack

    Returns False (fail-closed) if no signing secret is configured.
    """
    _, signing_secret = _get_slack_tokens()
    if not signing_secret:
        logger.error("Slack signing secret not configured — rejecting request (fail-closed)")
        return False

    timestamp = headers.get("x-slack-request-timestamp", "")
    signature = headers.get("x-slack-signature", "")

    if not timestamp or not signature:
        logger.warning("Slack webhook missing timestamp or signature headers")
        return False

    # Reject requests older than 5 minutes to prevent replay attacks
    try:
        if abs(time.time() - int(timestamp)) > 300:
            logger.warning("Slack webhook timestamp too old (replay attack prevention)")
            return False
    except (ValueError, TypeError):
        logger.warning("Slack webhook invalid timestamp: %s", timestamp)
        return False

    # Compute expected signature
    sig_basestring = f"v0:{timestamp}:{body}"
    expected = "v0=" + hmac.new(
        signing_secret.encode("utf-8"),
        sig_basestring.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        logger.warning("Slack webhook signature mismatch")
        return False

    return True


# ---------------------------------------------------------------------------
# DynamoDB identity helpers
# ---------------------------------------------------------------------------

def is_user_allowed(channel, channel_user_id):
    """Check if a new user is permitted to register.

    Returns True if:
    - REGISTRATION_OPEN is true (anyone can register), OR
    - An ALLOW#{channel}:{channel_user_id} record exists in DynamoDB

    This is only called for NEW users (no existing CHANNEL# record).
    Existing users and bind-code redemptions bypass this check.
    """
    if REGISTRATION_OPEN:
        return True
    channel_key = f"{channel}:{channel_user_id}"
    try:
        resp = identity_table.get_item(Key={"PK": f"ALLOW#{channel_key}", "SK": "ALLOW"})
        if "Item" in resp:
            return True
    except ClientError as e:
        logger.error("Allowlist check failed: %s", e)
    return False


def resolve_user(channel, channel_user_id, display_name=""):
    """Look up or create a user for the given channel identity.

    Returns (user_id, is_new). Returns (None, False) if user is not allowed.
    """
    channel_key = f"{channel}:{channel_user_id}"
    pk = f"CHANNEL#{channel_key}"

    # 1. Try to find existing mapping
    try:
        resp = identity_table.get_item(Key={"PK": pk, "SK": "PROFILE"})
        if "Item" in resp:
            return resp["Item"]["userId"], False
    except ClientError as e:
        logger.error("DynamoDB get_item failed: %s", e)

    # 2. Check allowlist before creating a new user
    if not is_user_allowed(channel, channel_user_id):
        logger.warning("User %s not on allowlist — rejecting registration", channel_key)
        return None, False

    # 3. Create new user (conditional write to handle race conditions)
    user_id = f"user_{uuid.uuid4().hex[:16]}"
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    try:
        # User profile
        identity_table.put_item(
            Item={
                "PK": f"USER#{user_id}",
                "SK": "PROFILE",
                "userId": user_id,
                "createdAt": now_iso,
                "displayName": display_name or channel_user_id,
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            logger.error("Failed to create user profile: %s", e)

    try:
        # Channel -> user mapping (conditional to prevent race)
        identity_table.put_item(
            Item={
                "PK": pk,
                "SK": "PROFILE",
                "userId": user_id,
                "channel": channel,
                "channelUserId": channel_user_id,
                "displayName": display_name or channel_user_id,
                "boundAt": now_iso,
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            # Another invocation created it first — read and return theirs
            resp = identity_table.get_item(Key={"PK": pk, "SK": "PROFILE"})
            if "Item" in resp:
                return resp["Item"]["userId"], False
        logger.error("Failed to create channel mapping: %s", e)

    # User -> channel back-reference
    try:
        identity_table.put_item(
            Item={
                "PK": f"USER#{user_id}",
                "SK": f"CHANNEL#{channel_key}",
                "channel": channel,
                "channelUserId": channel_user_id,
                "boundAt": now_iso,
            }
        )
    except ClientError:
        pass  # Non-critical

    logger.info("New user created: %s for %s", user_id, channel_key)
    return user_id, True


def get_or_create_session(user_id):
    """Get or create a session ID for the user. Session IDs must be >= 33 chars."""
    pk = f"USER#{user_id}"

    try:
        resp = identity_table.get_item(Key={"PK": pk, "SK": "SESSION"})
        if "Item" in resp:
            # Update last activity
            identity_table.update_item(
                Key={"PK": pk, "SK": "SESSION"},
                UpdateExpression="SET lastActivity = :now",
                ExpressionAttributeValues={":now": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            )
            return resp["Item"]["sessionId"]
    except ClientError as e:
        logger.error("DynamoDB session lookup failed: %s", e)

    # Create new session (>= 33 chars required by AgentCore)
    session_id = f"ses_{user_id}_{uuid.uuid4().hex[:12]}"
    if len(session_id) < 33:
        session_id += "_" + uuid.uuid4().hex[: 33 - len(session_id)]
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    try:
        identity_table.put_item(
            Item={
                "PK": pk,
                "SK": "SESSION",
                "sessionId": session_id,
                "createdAt": now_iso,
                "lastActivity": now_iso,
            }
        )
    except ClientError as e:
        logger.error("Failed to create session: %s", e)

    logger.info("New session created: %s for %s", session_id, user_id)
    return session_id


# ---------------------------------------------------------------------------
# Cross-channel binding
# ---------------------------------------------------------------------------

def create_bind_code(user_id):
    """Generate a 6-char bind code and store it in DynamoDB with TTL."""
    code = uuid.uuid4().hex[:6].upper()
    ttl = int(time.time()) + BIND_CODE_TTL_SECONDS
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    identity_table.put_item(
        Item={
            "PK": f"BIND#{code}",
            "SK": "BIND",
            "userId": user_id,
            "createdAt": now_iso,
            "ttl": ttl,
        }
    )
    return code


def redeem_bind_code(code, channel, channel_user_id, display_name=""):
    """Redeem a bind code to link a new channel identity to an existing user.

    Returns (user_id, success).
    """
    code = code.strip().upper()
    try:
        resp = identity_table.get_item(Key={"PK": f"BIND#{code}", "SK": "BIND"})
        item = resp.get("Item")
        if not item:
            return None, False
        # Check TTL (DynamoDB TTL deletion is eventual)
        if item.get("ttl", 0) < int(time.time()):
            return None, False

        user_id = item["userId"]
        channel_key = f"{channel}:{channel_user_id}"
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Create channel -> user mapping
        identity_table.put_item(
            Item={
                "PK": f"CHANNEL#{channel_key}",
                "SK": "PROFILE",
                "userId": user_id,
                "channel": channel,
                "channelUserId": channel_user_id,
                "displayName": display_name or channel_user_id,
                "boundAt": now_iso,
            }
        )
        # Back-reference
        identity_table.put_item(
            Item={
                "PK": f"USER#{user_id}",
                "SK": f"CHANNEL#{channel_key}",
                "channel": channel,
                "channelUserId": channel_user_id,
                "boundAt": now_iso,
            }
        )
        # Delete the bind code
        identity_table.delete_item(Key={"PK": f"BIND#{code}", "SK": "BIND"})

        logger.info("Bind code %s redeemed: %s -> %s", code, channel_key, user_id)
        return user_id, True
    except ClientError as e:
        logger.error("Bind code redemption failed: %s", e)
        return None, False


# ---------------------------------------------------------------------------
# AgentCore invocation
# ---------------------------------------------------------------------------

def invoke_agent_runtime(session_id, user_id, actor_id, channel, message, chat_id=None):
    """Invoke the AgentCore Runtime with a per-user session.

    Message can be a plain string or a structured dict with text + images.
    If chat_id is provided, the container will deliver the response directly
    to the channel (async mode) and return {"status": "accepted"} immediately.
    """
    payload_dict = {
        "action": "chat",
        "userId": user_id,
        "actorId": actor_id,
        "channel": channel,
        "message": message,
    }
    if chat_id:
        payload_dict["chatId"] = str(chat_id)
        payload_dict["channelTarget"] = str(chat_id)
    payload = json.dumps(payload_dict).encode()

    try:
        logger.info("Invoking AgentCore: arn=%s qualifier=%s session=%s", AGENTCORE_RUNTIME_ARN, AGENTCORE_QUALIFIER, session_id)
        resp = agentcore_client.invoke_agent_runtime(
            agentRuntimeArn=AGENTCORE_RUNTIME_ARN,
            qualifier=AGENTCORE_QUALIFIER,
            runtimeSessionId=session_id,
            payload=payload,
            contentType="application/json",
            accept="application/json",
        )
        status_code = resp.get("statusCode")
        logger.info("AgentCore response status: %s", status_code)
        body = resp.get("response")
        if body:
            if hasattr(body, "read"):
                body_text = body.read().decode("utf-8")
            else:
                body_text = str(body)
            logger.info("AgentCore response body (first 2000 chars): %s", body_text[:2000])
            try:
                return json.loads(body_text)
            except json.JSONDecodeError:
                return {"response": body_text}
        logger.warning("AgentCore returned no response body")
        return {"response": "No response from agent."}
    except Exception as e:
        logger.error("AgentCore invocation failed: %s", e, exc_info=True)
        return {"response": f"Sorry, I'm having trouble right now. Please try again later."}


# ---------------------------------------------------------------------------
# Channel message senders
# ---------------------------------------------------------------------------

def _extract_text_from_content_blocks(text):
    """Extract plain text if the response is a JSON array of content blocks.

    AI responses sometimes arrive wrapped as: [{"type":"text","text":"..."}]
    The inner text values may contain literal newlines, so strict=False is
    required for the JSON decoder.

    Recursively unwraps nested content blocks — subagent responses can produce
    multiple layers of wrapping (e.g., subagent → parent agent → bridge).
    """
    if not text or not isinstance(text, str):
        return text
    result = text
    # Loop to unwrap multiple nesting levels (max 10 to prevent infinite loops)
    for _ in range(10):
        stripped = result.strip()
        if not (stripped.startswith("[") and stripped.endswith("]")):
            break
        try:
            blocks = json.JSONDecoder(strict=False).decode(stripped)
            if isinstance(blocks, list) and blocks:
                parts = [b.get("text", "") for b in blocks
                         if isinstance(b, dict) and b.get("type") == "text"]
                if parts:
                    unwrapped = "".join(parts)
                    if unwrapped == result:
                        break  # No progress — avoid infinite loop
                    result = unwrapped
                    continue
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        break
    return result


def _markdown_to_telegram_html(text):
    """Convert common Markdown to Telegram-compatible HTML.

    Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>,
    <a href="">, <blockquote>, <tg-spoiler>.

    Strategy: extract code blocks/inline code first (protect from other
    conversions), HTML-escape the rest, convert markdown patterns, then
    re-insert code.
    """
    if not text:
        return text

    placeholders = []

    def _placeholder(content):
        idx = len(placeholders)
        placeholders.append(content)
        return f"\x00PH{idx}\x00"

    # 1. Extract fenced code blocks: ```lang\n...\n```
    text = re.sub(
        r"```\w*\n?(.*?)```",
        lambda m: _placeholder(
            "<pre>{}</pre>".format(
                m.group(1).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
        ),
        text, flags=re.DOTALL,
    )

    # 2. Extract markdown tables and render as monospace <pre> blocks
    def _convert_table(m):
        lines = m.group(0).strip().split("\n")
        rows = []
        for line in lines:
            # Skip separator rows (|---|---|)
            stripped = line.strip().strip("|").strip()
            if stripped and not re.match(r"^[\s|:-]+$", stripped):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                rows.append(cells)
        if not rows:
            return m.group(0)
        # Calculate column widths
        col_count = max(len(r) for r in rows)
        widths = [0] * col_count
        for row in rows:
            for i, cell in enumerate(row):
                if i < col_count:
                    # Strip markdown bold for width calculation
                    plain = re.sub(r"\*\*(.+?)\*\*", r"\1", cell)
                    widths[i] = max(widths[i], len(plain))
        # Format rows with padding
        formatted = []
        for ri, row in enumerate(rows):
            parts = []
            for i in range(col_count):
                cell = row[i] if i < len(row) else ""
                plain = re.sub(r"\*\*(.+?)\*\*", r"\1", cell)
                pad = widths[i] - len(plain) + len(cell)
                parts.append(cell.ljust(pad))
            formatted.append("  ".join(parts))
            # Add separator after header row
            if ri == 0:
                formatted.append("  ".join("─" * w for w in widths))
        table_text = "\n".join(formatted)
        table_text = table_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        # Convert bold inside table to HTML bold
        table_text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", table_text)
        return _placeholder(f"<pre>{table_text}</pre>")

    # Match consecutive lines that start with |
    text = re.sub(
        r"(?:^\|.+\|[ \t]*$\n?){2,}",
        _convert_table,
        text, flags=re.MULTILINE,
    )

    # 3. Extract inline code: `text`
    text = re.sub(
        r"`([^`\n]+)`",
        lambda m: _placeholder(
            "<code>{}</code>".format(
                m.group(1).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            )
        ),
        text,
    )

    # 4. HTML-escape remaining text
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    # 5. Convert markdown patterns to HTML

    # Headers: # Title → bold (Telegram has no header tag)
    text = re.sub(r"^#{1,6}\s+(.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)

    # Bold: **text** or __text__
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"__(.+?)__", r"<b>\1</b>", text)

    # Italic: *text* (but not bullet points like "* item")
    text = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"<i>\1</i>", text)

    # Strikethrough: ~~text~~
    text = re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)

    # Links: [text](url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)

    # Blockquotes: > text (at line start)
    text = re.sub(r"^&gt;\s?(.+)$", r"<blockquote>\1</blockquote>", text, flags=re.MULTILINE)
    # Merge adjacent blockquotes into one
    text = text.replace("</blockquote>\n<blockquote>", "\n")

    # Horizontal rules: --- or === or *** → thin line
    text = re.sub(r"^[-=*]{3,}\s*$", "———", text, flags=re.MULTILINE)

    # 6. Re-insert placeholders
    for idx, content in enumerate(placeholders):
        text = text.replace(f"\x00PH{idx}\x00", content)

    return text


def send_telegram_message(chat_id, text, token):
    """Send a message via Telegram Bot API.

    Converts Markdown to Telegram HTML for rich formatting. Falls back to
    plain text if Telegram rejects the HTML (e.g., malformed tags).
    """
    if not token:
        logger.error("No Telegram token available")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"

    # Try with HTML (converted from Markdown)
    html_text = _markdown_to_telegram_html(text)
    data = json.dumps({
        "chat_id": chat_id,
        "text": html_text,
        "parse_mode": "HTML",
    }).encode()
    req = urllib_request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib_request.urlopen(req, timeout=10)
        return
    except Exception as e:
        logger.warning("Telegram HTML send failed (retrying as plain text): %s", e)

    # Fallback: send as plain text (no parse_mode)
    data = json.dumps({
        "chat_id": chat_id,
        "text": text,
    }).encode()
    req = urllib_request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib_request.urlopen(req, timeout=10)
    except Exception as e:
        logger.error("Failed to send Telegram message to %s: %s", chat_id, e)


def send_telegram_typing(chat_id, token):
    """Send a typing indicator via Telegram Bot API."""
    if not token:
        return
    url = f"https://api.telegram.org/bot{token}/sendChatAction"
    data = json.dumps({"chat_id": chat_id, "action": "typing"}).encode()
    req = urllib_request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib_request.urlopen(req, timeout=5)
    except Exception:
        pass



def send_slack_message(channel_id, text, bot_token):
    """Send a message via Slack Web API."""
    if not bot_token:
        logger.error("No Slack bot token available")
        return
    url = "https://slack.com/api/chat.postMessage"
    data = json.dumps({
        "channel": channel_id,
        "text": text,
    }).encode()
    req = urllib_request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bot_token}",
        },
    )
    try:
        urllib_request.urlopen(req, timeout=10)
    except Exception as e:
        logger.error("Failed to send Slack message to %s: %s", channel_id, e)


def _download_file_from_s3(s3_key):
    """Download a file from the user-files S3 bucket. Returns bytes or None."""
    if not USER_FILES_BUCKET:
        logger.warning("USER_FILES_BUCKET not configured — cannot download file")
        return None
    try:
        resp = s3_client.get_object(Bucket=USER_FILES_BUCKET, Key=s3_key)
        return resp["Body"].read()
    except Exception as e:
        logger.error("S3 file download failed for %s: %s", s3_key, e)
        return None


def send_telegram_document(chat_id, file_bytes, filename, token, caption=None):
    """Send a file as a native document attachment via Telegram Bot API (multipart)."""
    if not token:
        logger.error("No Telegram token available")
        return
    import io
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    boundary = uuid.uuid4().hex
    body_parts = []
    # chat_id field
    body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}")
    # caption field (optional)
    if caption:
        body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption[:1024]}")
    # document field (binary)
    body_parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    )
    # Build multipart body
    payload = b""
    for part in body_parts[:-1]:
        payload += part.encode() + b"\r\n"
    # Last text part (before binary) + binary data + closing boundary
    payload += body_parts[-1].encode()
    payload += file_bytes
    payload += f"\r\n--{boundary}--\r\n".encode()

    req = urllib_request.Request(
        url, data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        urllib_request.urlopen(req, timeout=30)
        logger.info("Telegram document sent: %s (%d bytes)", filename, len(file_bytes))
    except Exception as e:
        logger.error("Failed to send Telegram document %s: %s", filename, e)


def send_slack_file(channel_id, file_bytes, filename, bot_token, comment=None):
    """Upload a file to Slack via files.uploadV2 (two-step: getUploadURLExternal + completeUploadExternal)."""
    if not bot_token:
        logger.error("No Slack bot token available")
        return
    headers_auth = {
        "Authorization": f"Bearer {bot_token}",
    }
    # Step 1: get upload URL
    step1_url = f"https://slack.com/api/files.getUploadURLExternal?filename={quote(filename)}&length={len(file_bytes)}"
    req1 = urllib_request.Request(step1_url, headers=headers_auth)
    try:
        resp1 = urllib_request.urlopen(req1, timeout=10)
        step1_data = json.loads(resp1.read().decode())
    except Exception as e:
        logger.error("Slack getUploadURLExternal failed: %s", e)
        return
    if not step1_data.get("ok"):
        logger.error("Slack getUploadURLExternal error: %s", step1_data.get("error"))
        return
    upload_url = step1_data["upload_url"]
    file_id = step1_data["file_id"]

    # Step 2: upload file bytes to the URL
    req2 = urllib_request.Request(upload_url, data=file_bytes, method="POST")
    req2.add_header("Content-Type", "application/octet-stream")
    try:
        urllib_request.urlopen(req2, timeout=30)
    except Exception as e:
        logger.error("Slack file upload failed: %s", e)
        return

    # Step 3: complete the upload and share to channel
    complete_data = json.dumps({
        "files": [{"id": file_id, "title": filename}],
        "channel_id": channel_id,
        **({"initial_comment": comment} if comment else {}),
    }).encode()
    req3 = urllib_request.Request(
        "https://slack.com/api/files.completeUploadExternal",
        data=complete_data,
        headers={"Content-Type": "application/json", **headers_auth},
    )
    try:
        resp3 = urllib_request.urlopen(req3, timeout=10)
        step3_data = json.loads(resp3.read().decode())
        if not step3_data.get("ok"):
            logger.error("Slack completeUploadExternal error: %s", step3_data.get("error"))
        else:
            logger.info("Slack file sent: %s (%d bytes)", filename, len(file_bytes))
    except Exception as e:
        logger.error("Slack completeUploadExternal failed: %s", e)


def _send_response_files(files, channel_type, chat_id, token_or_bot_token):
    """Download files from S3 and send as native attachments to the channel."""
    if not files:
        return
    for f in files:
        s3_key = f.get("s3Key")
        filename = f.get("filename", s3_key.rsplit("/", 1)[-1] if s3_key else "file")
        file_bytes = _download_file_from_s3(s3_key)
        if not file_bytes:
            logger.warning("Skipping file %s — could not download from S3", s3_key)
            continue
        if channel_type == "telegram":
            send_telegram_document(chat_id, file_bytes, filename, token_or_bot_token)
        elif channel_type == "slack":
            send_slack_file(chat_id, file_bytes, filename, token_or_bot_token)


# ---------------------------------------------------------------------------
# Image upload helpers
# ---------------------------------------------------------------------------

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_IMAGE_BYTES = 3_750_000  # 3.75 MB — Bedrock Converse image limit
CONTENT_TYPE_TO_EXT = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

ALLOWED_DOCUMENT_TYPES = {
    "application/pdf",
    "text/csv",
    "application/csv",
    "text/comma-separated-values",
    "text/plain",
    "application/json",
    "text/markdown",
    "text/html",
    "application/xml",
    "text/xml",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-excel.sheet.macroEnabled.12",  # .xlsm
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12",  # .xlsb
    "application/octet-stream",  # Generic binary — Telegram uses this for unrecognized file types
}
MAX_DOCUMENT_BYTES = 4_500_000  # 4.5 MB — Bedrock Converse document limit
DOCUMENT_TYPE_TO_EXT = {
    "application/pdf": "pdf",
    "text/csv": "csv",
    "application/csv": "csv",
    "text/comma-separated-values": "csv",
    "text/plain": "txt",
    "application/json": "json",
    "text/markdown": "md",
    "text/html": "html",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsm",
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12": "xlsb",
    "application/octet-stream": "bin",
}
ALLOWED_FILE_TYPES = ALLOWED_IMAGE_TYPES | ALLOWED_DOCUMENT_TYPES


def _upload_image_to_s3(image_bytes, namespace, content_type):
    """Upload image bytes to S3 and return the S3 key, or None on failure.

    S3 key: {namespace}/_uploads/img_{timestamp}_{hex}.{ext}
    """
    if not USER_FILES_BUCKET:
        logger.warning("USER_FILES_BUCKET not configured — cannot upload image")
        return None
    if content_type not in ALLOWED_IMAGE_TYPES:
        logger.warning("Rejected image with unsupported content type: %s", content_type)
        return None
    if len(image_bytes) > MAX_IMAGE_BYTES:
        logger.warning("Rejected image: %d bytes exceeds limit of %d", len(image_bytes), MAX_IMAGE_BYTES)
        return None

    ext = CONTENT_TYPE_TO_EXT.get(content_type, "bin")
    timestamp = int(time.time())
    hex_suffix = uuid.uuid4().hex[:8]
    s3_key = f"{namespace}/_uploads/img_{timestamp}_{hex_suffix}.{ext}"

    try:
        s3_client.put_object(
            Bucket=USER_FILES_BUCKET,
            Key=s3_key,
            Body=image_bytes,
            ContentType=content_type,
        )
        logger.info("Uploaded image to s3://%s/%s (%d bytes)", USER_FILES_BUCKET, s3_key, len(image_bytes))
        return s3_key
    except Exception as e:
        logger.error("S3 image upload failed: %s", e)
        return None


def _upload_document_to_s3(doc_bytes, namespace, content_type, original_filename=""):
    """Upload document bytes to S3 and return the S3 key, or None on failure.

    S3 key: {namespace}/_uploads/doc_{timestamp}_{hex}.{ext}
    """
    if not USER_FILES_BUCKET:
        logger.warning("USER_FILES_BUCKET not configured — cannot upload document")
        return None
    if content_type not in ALLOWED_DOCUMENT_TYPES:
        logger.warning("Rejected document with unsupported content type: %s", content_type)
        return None
    if len(doc_bytes) > MAX_DOCUMENT_BYTES:
        logger.warning("Rejected document: %d bytes exceeds limit of %d", len(doc_bytes), MAX_DOCUMENT_BYTES)
        return None

    ext = DOCUMENT_TYPE_TO_EXT.get(content_type, "bin")
    timestamp = int(time.time())
    hex_suffix = uuid.uuid4().hex[:8]
    s3_key = f"{namespace}/_uploads/doc_{timestamp}_{hex_suffix}.{ext}"

    try:
        s3_client.put_object(
            Bucket=USER_FILES_BUCKET,
            Key=s3_key,
            Body=doc_bytes,
            ContentType=content_type,
        )
        logger.info("Uploaded document to s3://%s/%s (%d bytes)", USER_FILES_BUCKET, s3_key, len(doc_bytes))
        return s3_key
    except Exception as e:
        logger.error("S3 document upload failed: %s", e)
        return None


def _download_telegram_document(message, token, inferred_mime=""):
    """Download a non-image document from a Telegram message.

    Returns (bytes, content_type, filename) or (None, None, None).
    """
    doc = message.get("document", {})
    mime = doc.get("mime_type", "") or inferred_mime
    if mime not in ALLOWED_DOCUMENT_TYPES:
        return None, None, None

    file_id = doc.get("file_id")
    if not file_id:
        return None, None, None

    original_filename = doc.get("file_name", "")

    try:
        safe_file_id = quote(str(file_id), safe="")
        url = f"https://api.telegram.org/bot{token}/getFile?file_id={safe_file_id}"
        req = urllib_request.Request(url)
        resp = urllib_request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode("utf-8"))
        file_path = data.get("result", {}).get("file_path", "")
        if not file_path:
            logger.warning("Telegram getFile returned no file_path for document file_id=%s", file_id)
            return None, None, None

        file_size = data.get("result", {}).get("file_size", 0)
        if file_size > MAX_DOCUMENT_BYTES:
            logger.warning("Telegram document too large: %d bytes", file_size)
            return None, None, None

        download_url = f"https://api.telegram.org/file/bot{token}/{file_path}"
        req = urllib_request.Request(download_url)
        resp = urllib_request.urlopen(req, timeout=15)
        doc_bytes = resp.read()

        filename = original_filename or (file_path.split("/")[-1] if "/" in file_path else file_path)
        return doc_bytes, mime, filename
    except Exception as e:
        logger.error("Telegram document download failed: %s", e)
        return None, None, None


def _download_telegram_image(message, token):
    """Download the best-resolution photo or image document from a Telegram message.

    Returns (bytes, content_type, filename) or (None, None, None).
    """
    file_id = None
    content_type = "image/jpeg"  # Telegram photos are always JPEG

    # Check photo array (take last = highest resolution)
    photos = message.get("photo")
    if photos and isinstance(photos, list):
        file_id = photos[-1].get("file_id")

    # Check document with image mime type
    if not file_id:
        doc = message.get("document", {})
        mime = doc.get("mime_type", "")
        if mime in ALLOWED_IMAGE_TYPES:
            file_id = doc.get("file_id")
            content_type = mime

    if not file_id:
        return None, None, None

    try:
        # Get file path from Telegram API
        safe_file_id = quote(str(file_id), safe="")
        url = f"https://api.telegram.org/bot{token}/getFile?file_id={safe_file_id}"
        req = urllib_request.Request(url)
        resp = urllib_request.urlopen(req, timeout=15)
        data = json.loads(resp.read().decode("utf-8"))
        file_path = data.get("result", {}).get("file_path", "")
        if not file_path:
            logger.warning("Telegram getFile returned no file_path for file_id=%s", file_id)
            return None, None, None

        # Check file size before downloading (Telegram includes it)
        file_size = data.get("result", {}).get("file_size", 0)
        if file_size > MAX_IMAGE_BYTES:
            logger.warning("Telegram file too large: %d bytes", file_size)
            return None, None, None

        # Download the file
        download_url = f"https://api.telegram.org/file/bot{token}/{file_path}"
        req = urllib_request.Request(download_url)
        resp = urllib_request.urlopen(req, timeout=15)
        image_bytes = resp.read()

        filename = file_path.split("/")[-1] if "/" in file_path else file_path
        return image_bytes, content_type, filename
    except Exception as e:
        logger.error("Telegram image download failed: %s", e)
        return None, None, None


def _download_slack_file(file_info, bot_token):
    """Download an image or document file from Slack.

    Returns (bytes, content_type, filename) or (None, None, None).
    """
    mimetype = file_info.get("mimetype", "")
    if mimetype not in ALLOWED_FILE_TYPES:
        return None, None, None

    file_size = file_info.get("size", 0)
    max_bytes = MAX_IMAGE_BYTES if mimetype in ALLOWED_IMAGE_TYPES else MAX_DOCUMENT_BYTES
    if file_size > max_bytes:
        logger.warning("Slack file too large: %d bytes (limit %d)", file_size, max_bytes)
        return None, None, None

    download_url = file_info.get("url_private_download") or file_info.get("url_private")
    if not download_url:
        logger.warning("Slack file has no download URL")
        return None, None, None

    try:
        req = urllib_request.Request(
            download_url,
            headers={"Authorization": f"Bearer {bot_token}"},
        )
        resp = urllib_request.urlopen(req, timeout=15)
        image_bytes = resp.read()
        filename = file_info.get("name", "image")
        return image_bytes, mimetype, filename
    except Exception as e:
        logger.error("Slack file download failed: %s", e)
        return None, None, None


def _build_structured_message(text, s3_key, content_type, filename=""):
    """Build a structured message dict with text and image/document reference."""
    msg = {"text": text or ""}
    if content_type in ALLOWED_IMAGE_TYPES:
        msg["images"] = [{"s3Key": s3_key, "contentType": content_type}]
    elif content_type in ALLOWED_DOCUMENT_TYPES:
        doc_ref = {"s3Key": s3_key, "contentType": content_type}
        if filename:
            doc_ref["name"] = filename
        msg["documents"] = [doc_ref]
    return msg


def _build_multi_image_message(text, image_refs):
    """Build a structured message dict with text and multiple image references."""
    return {
        "text": text or "",
        "images": [{"s3Key": ref["s3Key"], "contentType": ref["contentType"]}
                   for ref in image_refs],
    }


# ---------------------------------------------------------------------------
# Telegram media group buffering (parallel upload + wait-and-claim)
# ---------------------------------------------------------------------------
#
# When Telegram sends N photos as a media group, N separate webhooks arrive.
# Each webhook triggers an async-dispatch Lambda that uploads its image in
# parallel. After storing, each Lambda waits for a quiet period (no new images)
# then races to claim the group via DynamoDB conditional write. First to claim
# dispatches all images in a single AgentCore invocation.
#
# No recursive self-invocation — the wait happens inside each async-dispatch
# Lambda, which is already a background worker (webhook returned 200 instantly).

MEDIA_GROUP_QUIET_PERIOD = 3  # Seconds of inactivity before dispatching


def _store_media_group_image(media_group_id, image_ref, text, chat_id, actor_id, user_id):
    """Append an image to a media group record in DynamoDB.

    Creates the record on first call, appends images on subsequent calls.
    Returns True if this is the FIRST image stored (caller should start flush chain).
    Returns False if the image was appended to an existing record.
    Returns None on failure.
    """
    now_epoch = str(time.time())  # Stored as string for DynamoDB number compat
    ttl_epoch = int(time.time()) + 120  # Auto-expire after 2 minutes

    try:
        resp = identity_table.update_item(
            Key={"PK": f"MEDIAGRP#{media_group_id}", "SK": "MEDIAGRP"},
            UpdateExpression=(
                "SET #imgs = list_append(if_not_exists(#imgs, :empty_list), :new_img), "
                "#chatId = if_not_exists(#chatId, :chatId), "
                "#actorId = if_not_exists(#actorId, :actorId), "
                "#userId = if_not_exists(#userId, :userId), "
                "#channel = if_not_exists(#channel, :channel), "
                "#claimed = if_not_exists(#claimed, :false_val), "
                "#lastUpd = :now_epoch, "
                "#ttl = :ttl"
            ),
            ExpressionAttributeNames={
                "#imgs": "images",
                "#chatId": "chatId",
                "#actorId": "actorId",
                "#userId": "userId",
                "#channel": "channel",
                "#claimed": "claimed",
                "#lastUpd": "lastUpdated",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues={
                ":new_img": [image_ref],
                ":empty_list": [],
                ":chatId": str(chat_id),
                ":actorId": actor_id,
                ":userId": user_id,
                ":channel": "telegram",
                ":false_val": False,
                ":now_epoch": now_epoch,
                ":ttl": ttl_epoch,
            },
            ReturnValues="ALL_OLD",
        )
        # If ALL_OLD has no Attributes, this was a new record (first image)
        is_first = not resp.get("Attributes")

        # Store caption separately — only set if non-empty and not yet stored
        if text:
            try:
                identity_table.update_item(
                    Key={"PK": f"MEDIAGRP#{media_group_id}", "SK": "MEDIAGRP"},
                    UpdateExpression="SET #txt = if_not_exists(#txt, :txt)",
                    ExpressionAttributeNames={"#txt": "text"},
                    ExpressionAttributeValues={":txt": text},
                )
            except ClientError:
                pass  # Non-fatal — caption may already be set

        logger.info(
            "Stored media group image: group=%s is_first=%s",
            media_group_id, is_first,
        )
        return is_first
    except ClientError as e:
        logger.error("Failed to store media group image: %s", e)
        return None


def _claim_media_group(media_group_id):
    """Try to claim a media group for dispatch.

    Uses a conditional update to ensure only one Lambda invocation claims
    the group. Returns the full record if claim succeeds, None otherwise.
    """
    try:
        resp = identity_table.update_item(
            Key={"PK": f"MEDIAGRP#{media_group_id}", "SK": "MEDIAGRP"},
            UpdateExpression="SET #claimed = :true_val",
            ConditionExpression="#claimed = :false_val",
            ExpressionAttributeNames={"#claimed": "claimed"},
            ExpressionAttributeValues={
                ":true_val": True,
                ":false_val": False,
            },
            ReturnValues="ALL_NEW",
        )
        item = resp.get("Attributes", {})
        logger.info(
            "Claimed media group: group=%s images=%d",
            media_group_id, len(item.get("images", [])),
        )
        return item
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("Media group already claimed: group=%s", media_group_id)
            return None
        logger.error("Failed to claim media group: %s", e)
        return None


def _wait_and_claim_media_group(media_group_id):
    """Wait for the quiet period, then try to claim and dispatch the media group.

    Called by each async-dispatch Lambda after storing its image. All Lambdas
    wait in parallel, then race to claim. First to claim dispatches; others exit.
    No recursive self-invocation — avoids AWS Lambda recursive loop detection.
    """
    # Wait for the quiet period (all image uploads should be done by then)
    time.sleep(MEDIA_GROUP_QUIET_PERIOD)

    # Check if still quiet (no new images since we slept)
    try:
        resp = identity_table.get_item(
            Key={"PK": f"MEDIAGRP#{media_group_id}", "SK": "MEDIAGRP"},
        )
    except ClientError as e:
        logger.error("Media group read failed: %s", e)
        return

    item = resp.get("Item")
    if not item:
        logger.warning("Media group %s: record not found", media_group_id)
        return
    if item.get("claimed"):
        logger.info("Media group %s: already dispatched by another Lambda", media_group_id)
        return

    last_updated = float(item.get("lastUpdated", "0"))
    elapsed = time.time() - last_updated
    image_count = len(item.get("images", []))

    if elapsed < MEDIA_GROUP_QUIET_PERIOD:
        # Images still arriving — sleep for the remaining time and retry once
        remaining = MEDIA_GROUP_QUIET_PERIOD - elapsed + 0.5
        logger.info(
            "Media group %s: still active (%.1fs ago, %d images) — waiting %.1fs more",
            media_group_id, elapsed, image_count, remaining,
        )
        time.sleep(remaining)

    # Try to claim
    logger.info("Media group %s: attempting claim (%d images)", media_group_id, image_count)
    record = _claim_media_group(media_group_id)
    if record:
        _dispatch_media_group(record)
    else:
        logger.info("Media group %s: another Lambda dispatched", media_group_id)


def _dispatch_media_group(record):
    """Dispatch a complete media group to AgentCore.

    Reads all accumulated images from the DynamoDB record and sends
    them as a single multi-image structured message.
    """
    images = record.get("images", [])
    caption = record.get("text", "")
    user_id = record.get("userId", "")
    actor_id = record.get("actorId", "")
    chat_id = record.get("chatId", "")
    channel = record.get("channel", "telegram")

    if not user_id or not actor_id or not chat_id:
        logger.error("Media group dispatch: missing required fields")
        return

    if not images:
        logger.error("Media group dispatch: no images collected — notifying user")
        token = _get_telegram_token()
        send_telegram_message(
            int(chat_id),
            "Sorry, I couldn't process your images. Please try sending them again.",
            token,
        )
        return

    agent_message = _build_multi_image_message(caption, images)
    session_id = get_or_create_session(user_id)

    logger.info(
        "Dispatching media group: user=%s images=%d caption_len=%d",
        user_id, len(images), len(caption),
    )

    token = _get_telegram_token()
    send_telegram_typing(int(chat_id), token)

    result = invoke_agent_runtime(
        session_id, user_id, actor_id, channel, agent_message,
        chat_id=chat_id,
    )

    # Async mode: container delivers directly
    if result.get("status") == "accepted":
        logger.info("Media group dispatched (async mode) to chat_id=%s", chat_id)
        return

    # Sync fallback
    response_text = result.get("response", "Sorry, I couldn't process your images.")
    response_text = _extract_text_from_content_blocks(response_text)
    if len(response_text) <= 4096:
        send_telegram_message(int(chat_id), response_text, token)
    else:
        for i in range(0, len(response_text), 4096):
            send_telegram_message(int(chat_id), response_text[i:i + 4096], token)
    _send_response_files(result.get("files"), "telegram", int(chat_id), token)


# ---------------------------------------------------------------------------
# Webhook handlers
# ---------------------------------------------------------------------------

def _is_bind_command(text):
    """Check if the message is a bind-code command (e.g. 'link ABC123')."""
    if not text:
        return False, ""
    parts = text.strip().split()
    if len(parts) == 2 and parts[0].lower() in ("link", "bind"):
        code = parts[1].strip().upper()
        if len(code) == 6 and code.isalnum():
            return True, code
    return False, ""


def _is_link_command(text):
    """Check if the message is a 'link accounts' command."""
    if not text:
        return False
    return text.strip().lower() in ("link accounts", "link account", "link")


def handle_telegram(body):
    """Process a Telegram webhook update."""
    update = json.loads(body) if isinstance(body, str) else body

    # --- Dedup: skip already-processed updates ---
    # Telegram may send duplicate webhooks under network issues. Each update
    # has a unique update_id. Skip if we've already processed this one.
    update_id = update.get("update_id")
    if update_id is not None:
        if update_id in _processed_update_ids:
            logger.info("Telegram: skipping duplicate update_id=%s", update_id)
            return
        _processed_update_ids.add(update_id)
        _processed_update_ids_deque.append(update_id)
        # Evict oldest entries to keep the set bounded (deque auto-evicts,
        # but we must also remove from the set)
        while len(_processed_update_ids) > MAX_PROCESSED_UPDATE_IDS:
            old_id = _processed_update_ids_deque.popleft()
            _processed_update_ids.discard(old_id)

    message = update.get("message", {})
    text = message.get("text", "") or message.get("caption", "")
    chat_id = message.get("chat", {}).get("id")
    user = message.get("from", {})
    user_id_tg = str(user.get("id", ""))
    display_name = user.get("first_name", "") or user.get("username", "")

    # Detect image: photo array or document with image mime type
    doc_obj = message.get("document", {})
    doc_mime = doc_obj.get("mime_type", "")
    doc_filename = doc_obj.get("file_name", "")
    # Infer MIME from file extension when Telegram sends no mime_type
    if not doc_mime and doc_filename:
        EXT_TO_MIME = {
            ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain",
            ".json": "application/json", ".md": "text/markdown", ".html": "text/html",
            ".xml": "application/xml", ".xls": "application/vnd.ms-excel",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
            ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }
        ext = "." + doc_filename.rsplit(".", 1)[-1].lower() if "." in doc_filename else ""
        doc_mime = EXT_TO_MIME.get(ext, "application/octet-stream")
        logger.info("Telegram: inferred mime_type=%s from filename=%s", doc_mime, doc_filename)

    has_image = bool(
        message.get("photo")
        or (doc_mime in ALLOWED_IMAGE_TYPES)
    )
    # Detect document: document with allowed non-image mime type
    has_document = bool(
        not has_image
        and doc_obj
        and doc_mime in ALLOWED_DOCUMENT_TYPES
    )
    has_file = has_image or has_document

    # Log raw document info for debugging file type detection
    raw_doc = message.get("document")
    if raw_doc:
        logger.info(
            "Telegram: document detected — mime_type=%s file_name=%s file_size=%s has_image=%s has_document=%s",
            raw_doc.get("mime_type", "NONE"), raw_doc.get("file_name", "NONE"),
            raw_doc.get("file_size", "NONE"), has_image, has_document,
        )

    if not chat_id or not user_id_tg or (not text and not has_file):
        doc_mime = message.get("document", {}).get("mime_type", "")
        if doc_mime:
            logger.warning(
                "Telegram: rejected document with unsupported mime_type=%s filename=%s",
                doc_mime, message.get("document", {}).get("file_name", ""),
            )
        else:
            logger.info("Telegram: ignoring non-text/non-file or missing-user message")
        return

    token = _get_telegram_token()

    # Resolve user identity
    actor_id = f"telegram:{user_id_tg}"
    resolved_user_id, is_new = resolve_user("telegram", user_id_tg, display_name)

    if resolved_user_id is None:
        send_telegram_message(
            chat_id,
            f"Sorry, this bot is private and requires an invitation.\n\n"
            f"Your ID: `telegram:{user_id_tg}`\n\n"
            f"Send this ID to the bot admin to request access.",
            token,
        )
        return

    # Handle bind commands (text-only)
    if _is_link_command(text):
        code = create_bind_code(resolved_user_id)
        send_telegram_message(
            chat_id,
            f"Your link code is: `{code}`\n\nEnter this code on another channel within 10 minutes "
            f"by typing: `link {code}`",
            token,
        )
        return

    is_bind, code = _is_bind_command(text)
    if is_bind:
        bound_user_id, success = redeem_bind_code(code, "telegram", user_id_tg, display_name)
        if success:
            send_telegram_message(chat_id, "Accounts linked successfully! Your sessions are now unified.", token)
        else:
            send_telegram_message(chat_id, "Invalid or expired link code. Please try again.", token)
        return

    # Send typing indicator
    send_telegram_typing(chat_id, token)

    # Build message payload (structured if file attached, plain string if text-only)
    agent_message = text

    # --- Media group handling (multiple photos sent at once) ---
    # Each Lambda uploads its image in parallel and returns immediately.
    # The first image starts an async flush chain that dispatches once quiet.
    media_group_id = message.get("media_group_id")
    if media_group_id and has_image:
        namespace = actor_id.replace(":", "_")
        image_bytes, content_type, _ = _download_telegram_image(message, token)
        if not image_bytes:
            logger.warning("Media group: failed to download image for group=%s", media_group_id)
            return
        s3_key = _upload_image_to_s3(image_bytes, namespace, content_type)
        if not s3_key:
            logger.warning("Media group: failed to upload image for group=%s", media_group_id)
            return

        # Store image ref in DynamoDB (parallel-safe via atomic list_append)
        image_ref = {"s3Key": s3_key, "contentType": content_type}
        is_first = _store_media_group_image(
            media_group_id, image_ref, text, chat_id, actor_id, resolved_user_id,
        )
        if is_first is None:
            return  # Store failed

        # Wait for quiet period, then race to claim and dispatch.
        # This runs inside the async-dispatch Lambda (background worker) —
        # the webhook Lambda already returned 200 to Telegram instantly.
        # All async-dispatch Lambdas wait in parallel; first to claim dispatches.
        _wait_and_claim_media_group(media_group_id)
        return

    # --- Single image handling (no media group) ---
    elif has_image:
        namespace = actor_id.replace(":", "_")
        image_bytes, content_type, _ = _download_telegram_image(message, token)
        if image_bytes:
            s3_key = _upload_image_to_s3(image_bytes, namespace, content_type)
            if s3_key:
                agent_message = _build_structured_message(text, s3_key, content_type)
            else:
                send_telegram_message(chat_id, "Sorry, I couldn't process that image. Please try again.", token)
                return
        else:
            send_telegram_message(chat_id, "Sorry, I couldn't download that image. Please try again.", token)
            return
    elif has_document:
        namespace = actor_id.replace(":", "_")
        doc_bytes, content_type, filename = _download_telegram_document(message, token, inferred_mime=doc_mime)
        if doc_bytes:
            s3_key = _upload_document_to_s3(doc_bytes, namespace, content_type, filename)
            if s3_key:
                agent_message = _build_structured_message(text, s3_key, content_type, filename)
            else:
                send_telegram_message(chat_id, "Sorry, I couldn't process that document. Please try again.", token)
                return
        else:
            send_telegram_message(chat_id, "Sorry, I couldn't download that document. Please try again.", token)
            return

    # Get or create session
    session_id = get_or_create_session(resolved_user_id)

    image_count = 0 if isinstance(agent_message, str) else len(agent_message.get("images", []))
    doc_count = 0 if isinstance(agent_message, str) else len(agent_message.get("documents", []))
    logger.info(
        "Telegram: user=%s actor=%s session=%s text_len=%d images=%d docs=%d",
        resolved_user_id, actor_id, session_id, len(text), image_count, doc_count,
    )

    # Send initial typing indicator before invoke
    send_telegram_typing(chat_id, token)

    # Invoke AgentCore with chat_id for async direct response mode.
    # The container will send the response directly to Telegram/Slack,
    # so the Lambda doesn't need to block waiting for the full response.
    result = invoke_agent_runtime(
        session_id, resolved_user_id, actor_id, "telegram", agent_message,
        chat_id=chat_id,
    )

    # If container accepted the request (async mode), it will deliver directly
    if result.get("status") == "accepted":
        logger.info("Telegram: async mode — container will deliver response to chat_id=%s", chat_id)
        return

    # Fallback: sync mode (container returned full response — e.g., old container version)
    logger.info("AgentCore result keys: %s", list(result.keys()) if isinstance(result, dict) else type(result))
    response_text = result.get("response", "Sorry, I couldn't process your message.")
    # Extract plain text from content blocks if the contract server returned them raw
    response_text = _extract_text_from_content_blocks(response_text)
    logger.info("Response to send (len=%d): %s", len(response_text), response_text[:2000])

    # Send response (split if > 4096 chars for Telegram limit)
    if len(response_text) <= 4096:
        send_telegram_message(chat_id, response_text, token)
    else:
        for i in range(0, len(response_text), 4096):
            send_telegram_message(chat_id, response_text[i:i + 4096], token)

    # Send file attachments if present
    _send_response_files(result.get("files"), "telegram", chat_id, token)

    logger.info("Telegram response sent to chat_id=%s", chat_id)


def handle_slack(body, headers=None):
    """Process a Slack Events API webhook.

    Returns a response dict for immediate replies (url_verification).
    """
    event_data = json.loads(body) if isinstance(body, str) else body

    # Slack URL verification challenge
    if event_data.get("type") == "url_verification":
        return {"statusCode": 200, "body": json.dumps({"challenge": event_data["challenge"]})}

    # Ignore retries (Slack resends if no ACK within 3s — we self-invoke async)
    if headers and headers.get("x-slack-retry-num"):
        logger.info("Slack: ignoring retry %s", headers.get("x-slack-retry-num"))
        return {"statusCode": 200, "body": "ok"}

    event = event_data.get("event", {})
    # Allow "file_share" subtype (image uploads) in addition to plain messages
    if event.get("type") != "message" or event.get("subtype") not in (None, "file_share"):
        return {"statusCode": 200, "body": "ok"}

    text = event.get("text", "")
    slack_user_id = event.get("user", "")
    channel_id = event.get("channel", "")

    # Detect attached files (images and documents)
    all_files = event.get("files") or []
    image_files = [f for f in all_files if f.get("mimetype", "") in ALLOWED_IMAGE_TYPES]
    document_files = [f for f in all_files if f.get("mimetype", "") in ALLOWED_DOCUMENT_TYPES]
    has_image = bool(image_files)
    has_document = bool(document_files) and not has_image
    has_file = has_image or has_document

    if not slack_user_id or not channel_id or (not text and not has_file):
        return {"statusCode": 200, "body": "ok"}

    # Ignore bot messages
    if event.get("bot_id"):
        return {"statusCode": 200, "body": "ok"}

    bot_token, _ = _get_slack_tokens()

    # Resolve user identity
    actor_id = f"slack:{slack_user_id}"
    resolved_user_id, is_new = resolve_user("slack", slack_user_id)

    if resolved_user_id is None:
        send_slack_message(
            channel_id,
            f"Sorry, this bot is private and requires an invitation.\n\n"
            f"Your ID: `slack:{slack_user_id}`\n\n"
            f"Send this ID to the bot admin to request access.",
            bot_token,
        )
        return {"statusCode": 200, "body": "ok"}

    # Handle bind commands (text-only)
    if _is_link_command(text):
        code = create_bind_code(resolved_user_id)
        send_slack_message(
            channel_id,
            f"Your link code is: `{code}`\n\nEnter this code on another channel within 10 minutes "
            f"by typing: `link {code}`",
            bot_token,
        )
        return {"statusCode": 200, "body": "ok"}

    is_bind, code = _is_bind_command(text)
    if is_bind:
        bound_user_id, success = redeem_bind_code(code, "slack", slack_user_id)
        if success:
            send_slack_message(channel_id, "Accounts linked successfully! Your sessions are now unified.", bot_token)
        else:
            send_slack_message(channel_id, "Invalid or expired link code. Please try again.", bot_token)
        return {"statusCode": 200, "body": "ok"}

    # Build message payload (structured if file attached, plain string if text-only)
    agent_message = text
    if has_image:
        namespace = actor_id.replace(":", "_")
        # Process all image files (Slack sends all files in one event — no buffering needed)
        uploaded_images = []
        for file_info in image_files:
            image_bytes, content_type, _ = _download_slack_file(file_info, bot_token)
            if image_bytes:
                s3_key = _upload_image_to_s3(image_bytes, namespace, content_type)
                if s3_key:
                    uploaded_images.append({"s3Key": s3_key, "contentType": content_type})
        if uploaded_images:
            if len(uploaded_images) == 1:
                agent_message = _build_structured_message(text, uploaded_images[0]["s3Key"], uploaded_images[0]["contentType"])
            else:
                agent_message = _build_multi_image_message(text, uploaded_images)
        else:
            send_slack_message(channel_id, "Sorry, I couldn't process the image(s). Please try again.", bot_token)
            return {"statusCode": 200, "body": "ok"}
    elif has_document:
        namespace = actor_id.replace(":", "_")
        file_info = document_files[0]
        doc_bytes, content_type, filename = _download_slack_file(file_info, bot_token)
        if doc_bytes:
            s3_key = _upload_document_to_s3(doc_bytes, namespace, content_type, filename)
            if s3_key:
                agent_message = _build_structured_message(text, s3_key, content_type, filename)
            else:
                send_slack_message(channel_id, "Sorry, I couldn't process that document. Please try again.", bot_token)
                return {"statusCode": 200, "body": "ok"}
        else:
            send_slack_message(channel_id, "Sorry, I couldn't download that document. Please try again.", bot_token)
            return {"statusCode": 200, "body": "ok"}

    # Get or create session
    session_id = get_or_create_session(resolved_user_id)

    logger.info(
        "Slack: user=%s actor=%s session=%s msg_len=%d has_file=%s",
        resolved_user_id, actor_id, session_id, len(text), has_file,
    )

    # Invoke AgentCore with channel_id for async direct response mode.
    result = invoke_agent_runtime(
        session_id, resolved_user_id, actor_id, "slack", agent_message,
        chat_id=channel_id,
    )

    # If container accepted the request (async mode), it will deliver directly
    if result.get("status") == "accepted":
        logger.info("Slack: async mode — container will deliver response to channel_id=%s", channel_id)
        return {"statusCode": 200, "body": "ok"}

    # Fallback: sync mode (container returned full response — e.g., old container version)
    response_text = result.get("response", "Sorry, I couldn't process your message.")
    response_text = _extract_text_from_content_blocks(response_text)

    send_slack_message(channel_id, response_text, bot_token)

    # Send file attachments if present
    _send_response_files(result.get("files"), "slack", channel_id, bot_token)

    return {"statusCode": 200, "body": "ok"}


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """Lambda handler (API Gateway HTTP API) with async self-invocation for long processing."""
    # Check if this is an async self-invocation (already dispatched)
    if event.get("_async_dispatch"):
        channel = event.get("_channel")
        body = event.get("_body")
        headers = event.get("_headers", {})

        if channel == "telegram":
            handle_telegram(body)
        elif channel == "slack":
            handle_slack(body, headers)
        return {"statusCode": 200, "body": "ok"}

    # --- Function URL entry point ---
    request_context = event.get("requestContext", {})
    http_info = request_context.get("http", {})
    method = http_info.get("method", "")
    path = http_info.get("path", event.get("rawPath", ""))

    # Health check
    if method == "GET" and path == "/health":
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "ok", "service": "openclaw-router"}),
        }

    if method != "POST":
        return {"statusCode": 405, "body": "Method not allowed"}

    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8")

    headers = event.get("headers", {})

    # Determine channel from path
    if path.endswith("/webhook/telegram"):
        # Validate webhook secret before processing
        if not validate_telegram_webhook(headers):
            logger.warning("Telegram webhook validation failed from %s", http_info.get("sourceIp", "unknown"))
            return {"statusCode": 401, "body": "Unauthorized"}

        # Self-invoke async and return immediately
        _self_invoke_async("telegram", body, headers)
        return {"statusCode": 200, "body": "ok"}

    elif path.endswith("/webhook/slack"):
        # Validate Slack request signature before any processing
        if not validate_slack_webhook(headers, body):
            logger.warning("Slack webhook validation failed from %s", http_info.get("sourceIp", "unknown"))
            return {"statusCode": 401, "body": "Unauthorized"}

        # Slack requires immediate response for url_verification
        try:
            event_data = json.loads(body) if isinstance(body, str) else body
            if event_data.get("type") == "url_verification":
                return {
                    "statusCode": 200,
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps({"challenge": event_data["challenge"]}),
                }
        except (json.JSONDecodeError, TypeError):
            pass

        # Ignore Slack retries
        if headers.get("x-slack-retry-num"):
            return {"statusCode": 200, "body": "ok"}

        # Self-invoke async for actual processing
        _self_invoke_async("slack", body, headers)
        return {"statusCode": 200, "body": "ok"}

    return {"statusCode": 404, "body": "Not found"}


def _self_invoke_async(channel, body, headers):
    """Invoke this Lambda asynchronously to process the webhook in the background."""
    try:
        lambda_client.invoke(
            FunctionName=LAMBDA_FUNCTION_NAME,
            InvocationType="Event",  # async
            Payload=json.dumps({
                "_async_dispatch": True,
                "_channel": channel,
                "_body": body,
                "_headers": {k: v for k, v in (headers or {}).items()
                             if k.startswith("x-slack-")},
            }).encode(),
        )
    except Exception as e:
        logger.error("Self-invoke failed: %s", e, exc_info=True)
        # Do NOT fall back to synchronous processing — it could cause webhook
        # timeouts and the user's message will appear lost. The message is
        # already ACK'd to the platform; log the error for investigation.
