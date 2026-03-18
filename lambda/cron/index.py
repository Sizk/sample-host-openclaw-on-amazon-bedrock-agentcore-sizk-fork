"""Cron Executor Lambda — Triggered by EventBridge Scheduler.

Receives a scheduled event payload, warms up the user's AgentCore session
if cold, sends the cron message, and delivers the response to the user's
channel (Telegram or Slack).
"""

import hashlib
import json
import logging
import os
import re
import time
import uuid
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
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
LAMBDA_TIMEOUT_SECONDS = int(os.environ.get("LAMBDA_TIMEOUT_SECONDS", "600"))

# --- Clients ---
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
identity_table = dynamodb.Table(IDENTITY_TABLE_NAME)
agentcore_client = boto3.client(
    "bedrock-agentcore",
    region_name=AWS_REGION,
    config=Config(
        read_timeout=60,  # Warmup + async cron should respond within seconds
        connect_timeout=10,
        retries={"max_attempts": 0},
    ),
)
secrets_client = boto3.client("secretsmanager", region_name=AWS_REGION)
s3_client = boto3.client("s3", region_name=AWS_REGION)

USER_FILES_BUCKET = os.environ.get("USER_FILES_BUCKET", "")

# --- Token cache (survives across warm invocations) ---
_token_cache = {}

# --- Constants ---
WARMUP_POLL_INTERVAL_SECONDS = 15
WARMUP_MAX_WAIT_SECONDS = 300


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
    """Return (bot_token, signing_secret) tuple from Slack secret."""
    raw = _get_secret(SLACK_TOKEN_SECRET_ID)
    if not raw:
        return "", ""
    try:
        data = json.loads(raw)
        return data.get("botToken", ""), data.get("signingSecret", "")
    except (json.JSONDecodeError, TypeError):
        return raw, ""


# ---------------------------------------------------------------------------
# DynamoDB session management (reuse pattern from router Lambda)
# ---------------------------------------------------------------------------

def get_or_create_session(user_id):
    """Get or create a session ID for the user. Session IDs must be >= 33 chars."""
    pk = f"USER#{user_id}"

    try:
        resp = identity_table.get_item(Key={"PK": pk, "SK": "SESSION"})
        if "Item" in resp:
            identity_table.update_item(
                Key={"PK": pk, "SK": "SESSION"},
                UpdateExpression="SET lastActivity = :now",
                ExpressionAttributeValues={
                    ":now": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                },
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
# AgentCore invocation helpers
# ---------------------------------------------------------------------------

def invoke_agentcore(session_id, action, user_id, actor_id, channel, message=None, chat_id=None):
    """Invoke AgentCore Runtime with the given action."""
    payload_dict = {
        "action": action,
        "userId": user_id,
        "actorId": actor_id,
        "channel": channel,
    }
    if message:
        payload_dict["message"] = message
    if chat_id:
        payload_dict["chatId"] = chat_id

    payload = json.dumps(payload_dict).encode()

    try:
        logger.info(
            "Invoking AgentCore: action=%s session=%s user=%s",
            action, session_id, user_id,
        )
        resp = agentcore_client.invoke_agent_runtime(
            agentRuntimeArn=AGENTCORE_RUNTIME_ARN,
            qualifier=AGENTCORE_QUALIFIER,
            runtimeSessionId=session_id,
            payload=payload,
            contentType="application/json",
            accept="application/json",
        )
        body = resp.get("response")
        if body:
            if hasattr(body, "read"):
                body_text = body.read().decode("utf-8")
            else:
                body_text = str(body)
            logger.info("AgentCore response (first 500): %s", body_text[:500])
            try:
                return json.loads(body_text)
            except json.JSONDecodeError:
                return {"response": body_text}
        return {"response": "No response from agent."}
    except Exception as e:
        logger.error("AgentCore invocation failed: %s", e, exc_info=True)
        return {"response": f"Agent invocation failed: {e}"}


def warmup_and_wait(session_id, user_id, actor_id, channel, context=None):
    """Send warmup action and poll until the container is ready.

    Returns True if the container is ready, False if warmup timed out.
    Uses Lambda remaining time if available to avoid exceeding Lambda timeout.
    """
    # Reserve 120s for the actual cron invocation + response delivery
    RESERVE_SECONDS = 120
    if context and hasattr(context, "get_remaining_time_in_millis"):
        max_wait = min(WARMUP_MAX_WAIT_SECONDS,
                       (context.get_remaining_time_in_millis() / 1000) - RESERVE_SECONDS)
    else:
        max_wait = WARMUP_MAX_WAIT_SECONDS

    if max_wait <= 0:
        logger.error("Not enough remaining Lambda time for warmup (need %ds reserve)", RESERVE_SECONDS)
        return False

    start = time.time()
    while time.time() - start < max_wait:
        result = invoke_agentcore(session_id, "warmup", user_id, actor_id, channel)
        status = result.get("status", "")
        logger.info("Warmup status: %s (elapsed: %.0fs)", status, time.time() - start)

        if status == "ready":
            return True

        if status != "initializing":
            # Unexpected status — might already be running or encountered an error
            # Try sending the cron action anyway
            logger.warning("Unexpected warmup status: %s — proceeding", status)
            return True

        time.sleep(WARMUP_POLL_INTERVAL_SECONDS)

    logger.error("Warmup timed out after %ds", WARMUP_MAX_WAIT_SECONDS)
    return False


# ---------------------------------------------------------------------------
# Channel message senders (duplicated from router Lambda — small and stable)
# ---------------------------------------------------------------------------

def _extract_text_from_content_blocks(text):
    """Extract plain text if the response is a JSON array of content blocks.

    Recursively unwraps nested content blocks — subagent responses can produce
    multiple layers of wrapping (e.g., subagent -> parent agent -> bridge).
    """
    if not text or not isinstance(text, str):
        return text
    result = text
    for _ in range(10):
        stripped = result.strip()
        if not (stripped.startswith("[") and stripped.endswith("]")):
            break
        try:
            blocks = json.JSONDecoder(strict=False).decode(stripped)
            if isinstance(blocks, list) and blocks:
                parts = [
                    b.get("text", "")
                    for b in blocks
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                if parts:
                    unwrapped = "".join(parts)
                    if unwrapped == result:
                        break
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
            stripped = line.strip().strip("|").strip()
            if stripped and not re.match(r"^[\s|:-]+$", stripped):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                rows.append(cells)
        if not rows:
            return m.group(0)
        col_count = max(len(r) for r in rows)
        widths = [0] * col_count
        for row in rows:
            for i, cell in enumerate(row):
                if i < col_count:
                    plain = re.sub(r"\*\*(.+?)\*\*", r"\1", cell)
                    widths[i] = max(widths[i], len(plain))
        formatted = []
        for ri, row in enumerate(rows):
            parts = []
            for i in range(col_count):
                cell = row[i] if i < len(row) else ""
                plain = re.sub(r"\*\*(.+?)\*\*", r"\1", cell)
                pad = widths[i] - len(plain) + len(cell)
                parts.append(cell.ljust(pad))
            formatted.append("  ".join(parts))
            if ri == 0:
                formatted.append("  ".join("─" * w for w in widths))
        table_text = "\n".join(formatted)
        table_text = table_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        table_text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", table_text)
        return _placeholder(f"<pre>{table_text}</pre>")

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
    text = re.sub(r"^#{1,6}\s+(.+)$", r"<b>\1</b>", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"__(.+?)__", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"<i>\1</i>", text)
    text = re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"^&gt;\s?(.+)$", r"<blockquote>\1</blockquote>", text, flags=re.MULTILINE)
    text = text.replace("</blockquote>\n<blockquote>", "\n")
    text = re.sub(r"^[-=*]{3,}\s*$", "———", text, flags=re.MULTILINE)

    # 6. Re-insert placeholders
    for idx, content in enumerate(placeholders):
        text = text.replace(f"\x00PH{idx}\x00", content)

    return text


def send_telegram_message(chat_id, text, token):
    """Send a message via Telegram Bot API.

    Converts Markdown to Telegram HTML for rich formatting. Falls back to
    plain text if Telegram rejects the HTML.
    """
    if not token:
        logger.error("No Telegram token available")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"

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
        logger.warning("Telegram HTML send failed (retrying plain): %s", e)

    # Fallback: plain text
    data = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib_request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib_request.urlopen(req, timeout=10)
    except Exception as e:
        logger.error("Failed to send Telegram message to %s: %s", chat_id, e)


def send_slack_message(channel_id, text, bot_token):
    """Send a message via Slack Web API."""
    if not bot_token:
        logger.error("No Slack bot token available")
        return
    url = "https://slack.com/api/chat.postMessage"
    data = json.dumps({"channel": channel_id, "text": text}).encode()
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


def send_telegram_document(chat_id, file_bytes, filename, token):
    """Send a file as a native document attachment via Telegram Bot API (multipart)."""
    if not token:
        logger.error("No Telegram token available")
        return
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    boundary = uuid.uuid4().hex
    body_parts = []
    body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}")
    body_parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    )
    payload = body_parts[0].encode() + b"\r\n"
    payload += body_parts[1].encode()
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


def send_slack_file(channel_id, file_bytes, filename, bot_token):
    """Upload a file to Slack via files.uploadV2."""
    if not bot_token:
        logger.error("No Slack bot token available")
        return
    headers_auth = {"Authorization": f"Bearer {bot_token}"}
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
    req2 = urllib_request.Request(upload_url, data=file_bytes, method="POST")
    req2.add_header("Content-Type", "application/octet-stream")
    try:
        urllib_request.urlopen(req2, timeout=30)
    except Exception as e:
        logger.error("Slack file upload failed: %s", e)
        return
    complete_data = json.dumps({
        "files": [{"id": file_id, "title": filename}],
        "channel_id": channel_id,
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


def _send_response_files(files, channel, channel_target, token, bot_token):
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
        if channel == "telegram":
            send_telegram_document(channel_target, file_bytes, filename, token)
        elif channel == "slack":
            send_slack_file(channel_target, file_bytes, filename, bot_token)


def deliver_response(channel, channel_target, response_text, files=None):
    """Deliver a response to the user's channel."""
    response_text = _extract_text_from_content_blocks(response_text)

    if channel == "telegram":
        token = _get_telegram_token()
        if len(response_text) <= 4096:
            send_telegram_message(channel_target, response_text, token)
        else:
            for i in range(0, len(response_text), 4096):
                send_telegram_message(channel_target, response_text[i : i + 4096], token)
        _send_response_files(files, channel, channel_target, token, None)
    elif channel == "slack":
        bot_token, _ = _get_slack_tokens()
        send_slack_message(channel_target, response_text, bot_token)
        _send_response_files(files, channel, channel_target, None, bot_token)
    else:
        logger.warning("Unknown channel type: %s", channel)


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """Handle EventBridge Scheduler trigger.

    Expected payload:
    {
        "userId": "user_abc123",
        "actorId": "telegram:12345",
        "channel": "telegram",
        "channelTarget": "12345",
        "message": "Check my email",
        "scheduleId": "a1b2c3d4",
        "scheduleName": "Daily email check"
    }
    """
    logger.info("Cron event received: %s", json.dumps(event)[:1000])

    user_id = event.get("userId")
    actor_id = event.get("actorId")
    channel = event.get("channel")
    channel_target = event.get("channelTarget")
    message = event.get("message")
    schedule_id = event.get("scheduleId", "unknown")
    schedule_name = event.get("scheduleName", "")

    if not all([user_id, actor_id, channel, channel_target, message]):
        logger.error(
            "Missing required fields. userId=%s actorId=%s channel=%s target=%s msg=%s",
            user_id, actor_id, channel, channel_target, bool(message),
        )
        return {"statusCode": 400, "body": "Missing required fields"}

    logger.info(
        "Processing cron: schedule=%s user=%s channel=%s:%s",
        schedule_id, user_id, channel, channel_target,
    )

    # Phase 1: Get or create session
    session_id = get_or_create_session(user_id)

    # Phase 2: Warm up the container if cold
    warmup_ok = warmup_and_wait(session_id, user_id, actor_id, channel, context=context)
    if not warmup_ok:
        error_msg = (
            f"[Scheduled: {schedule_name or schedule_id}] "
            "Your scheduled task could not run because the agent failed to start. "
            "It will try again at the next scheduled time."
        )
        deliver_response(channel, channel_target, error_msg)
        return {"statusCode": 503, "body": "Warmup timeout"}

    # Phase 3: Execute the cron message (async — container delivers directly)
    cron_message = f"[Scheduled task: {schedule_name or schedule_id}] {message}"
    result = invoke_agentcore(
        session_id, "cron", user_id, actor_id, channel,
        cron_message, chat_id=channel_target,
    )

    # In async mode the container delivers the response directly to the channel.
    # The Lambda only needs to confirm the request was accepted.
    status = result.get("status", "")
    if status == "accepted":
        logger.info(
            "Cron async mode — container will deliver response to %s:%s",
            channel, channel_target,
        )
    else:
        # Sync fallback (legacy) or error — deliver response from Lambda
        response_text = result.get("response", "No response from scheduled task.")
        response_files = result.get("files")
        logger.info(
            "Delivering response (len=%d) to %s:%s",
            len(response_text), channel, channel_target,
        )
        deliver_response(channel, channel_target, response_text, files=response_files)

    logger.info("Cron execution complete: schedule=%s", schedule_id)
    return {"statusCode": 200, "body": "OK"}
