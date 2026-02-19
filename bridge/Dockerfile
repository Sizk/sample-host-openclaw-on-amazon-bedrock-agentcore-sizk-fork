# AgentCore Runtime requires ARM64
FROM --platform=linux/arm64 node:22-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq git python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

# Install AWS CLI (for Secrets Manager in entrypoint)
RUN pip3 install --no-cache-dir --break-system-packages awscli

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Create app directory and config directory
RUN mkdir -p /app /root/.openclaw

WORKDIR /app

# Install AWS SDK for Bedrock Runtime and Cognito (used by the proxy adapter)
RUN cd /app && npm init -y > /dev/null 2>&1 && \
    npm install @aws-sdk/client-bedrock-runtime \
                @aws-sdk/client-cognito-identity-provider

# Copy application files
COPY agentcore-contract.js /app/agentcore-contract.js
COPY agentcore-proxy.js /app/agentcore-proxy.js
COPY force-ipv4.js /app/force-ipv4.js

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# AgentCore Runtime requires port 8080
EXPOSE 8080

# AgentCore Runtime uses /ping for health checks (not Docker HEALTHCHECK)
# No HEALTHCHECK directive needed — AgentCore manages this via /ping endpoint

ENTRYPOINT ["/app/entrypoint.sh"]
