# ============================================================
# Stage 1: Builder — install all dependencies and tools
# ============================================================
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim AS builder

# Install system dependencies (gcc + cairo dev libs needed to compile pycairo for xhtml2pdf)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq git python3 python3-pip \
        gcc pkg-config libcairo2-dev python3-dev && \
    rm -rf /var/lib/apt/lists/*

# Install AWS CLI and file generation libraries
# PDF: xhtml2pdf (HTML→PDF), markdown (MD→HTML), fpdf2 (simple PDFs)
# Charts/Images: matplotlib, pillow
# Other: qrcode (QR codes), icalendar (ICS calendar files)
# Scraping: scrapling + curl_cffi for TLS-impersonating HTTP fetcher (no browsers needed)
RUN pip3 install --no-cache-dir --break-system-packages \
    awscli fpdf2 xhtml2pdf markdown \
    matplotlib pillow qrcode icalendar \
    scrapling curl_cffi openpyxl

# Create app directory
RUN mkdir -p /app

WORKDIR /app

# Install AWS SDK and WebSocket library (production only)
# ws is a transitive dependency of puppeteer-core for CDP connections
RUN cd /app && npm init -y > /dev/null 2>&1 && \
    npm install --omit=dev \
                @aws-sdk/client-bedrock-runtime \
                @aws-sdk/client-cognito-identity-provider \
                @aws-sdk/client-s3 \
                @aws-sdk/client-secrets-manager \
                @aws-sdk/client-scheduler \
                @aws-sdk/client-dynamodb \
                @aws-sdk/client-sts \
                @aws-sdk/lib-dynamodb \
                ws \
                puppeteer-core

# Pre-warm V8 compile cache for heavy AWS SDK modules.
# This populates the bytecode cache at build time so runtime module loading is faster.
RUN mkdir -p /app/.compile-cache && \
    NODE_COMPILE_CACHE=/app/.compile-cache node -e " \
      require('@aws-sdk/client-bedrock-runtime'); \
      require('@aws-sdk/client-cognito-identity-provider'); \
      require('@aws-sdk/client-s3'); \
      require('@aws-sdk/client-secrets-manager'); \
      require('@aws-sdk/client-scheduler'); \
      require('@aws-sdk/client-dynamodb'); \
      require('@aws-sdk/client-sts'); \
      require('@aws-sdk/lib-dynamodb'); \
      require('ws'); \
      require('puppeteer-core'); \
      console.log('[build] V8 compile cache pre-warmed'); \
    "

# Install Lightpanda browser (ARM64 binary — headless browser for web scraping)
# 10x faster than Chrome, 10x less memory. Used via CDP with puppeteer-core.
RUN curl -L -o /usr/local/bin/lightpanda \
    https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-linux && \
    chmod a+x /usr/local/bin/lightpanda

# ============================================================
# Stage 2: Runtime — minimal image with only needed artifacts
# ============================================================
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22-slim

# Install runtime system dependencies (pip3 for on-demand installs, libcairo2 for xhtml2pdf/pycairo)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq python3 python3-pip libcairo2 && \
    rm -rf /var/lib/apt/lists/*

# Copy AWS CLI from builder
COPY --from=builder /usr/local/bin/aws /usr/local/bin/aws
COPY --from=builder /usr/local/lib/python3.*/dist-packages /usr/local/lib/python3.11/dist-packages
COPY --from=builder /usr/lib/python3/dist-packages /usr/lib/python3/dist-packages

# Copy Lightpanda browser binary from builder
COPY --from=builder /usr/local/bin/lightpanda /usr/local/bin/lightpanda

# Copy app directory (node_modules, compile cache)
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/.compile-cache /app/.compile-cache

# Ensure skills can resolve npm packages from /app/node_modules
ENV NODE_PATH=/app/node_modules

WORKDIR /app

# Copy application files
COPY agentcore-contract.js /app/agentcore-contract.js
COPY custom-agent.js /app/custom-agent.js
COPY agentcore-proxy.js /app/agentcore-proxy.js
COPY lightpanda-fetch.js /app/lightpanda-fetch.js
COPY channel-sender.js /app/channel-sender.js
COPY workspace-sync.js /app/workspace-sync.js
COPY scoped-credentials.js /app/scoped-credentials.js
COPY force-ipv4.js /app/force-ipv4.js

# Copy custom per-user file storage skill
COPY skills/s3-user-files /skills/s3-user-files
RUN chmod +x /skills/s3-user-files/*.js

# Copy EventBridge cron scheduling skill
COPY skills/eventbridge-cron /skills/eventbridge-cron
RUN chmod +x /skills/eventbridge-cron/*.js

# Copy project instructions (CLAUDE.md) so the agent knows about its skills
COPY CLAUDE.md /app/CLAUDE.md

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# AgentCore Runtime requires port 8080
EXPOSE 8080

# AgentCore Runtime uses /ping for health checks (not Docker HEALTHCHECK)
# No HEALTHCHECK directive needed — AgentCore manages this via /ping endpoint
# Note: container runs as root inside a per-user AgentCore microVM (already isolated).

ENTRYPOINT ["/app/entrypoint.sh"]
