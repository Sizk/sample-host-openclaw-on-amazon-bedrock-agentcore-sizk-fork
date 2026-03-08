/**
 * OpenClaw config generator — single source of truth.
 *
 * Used by agentcore-contract.js (to write openclaw.json at runtime) and by
 * config-validation.test.js (to validate the config against OpenClaw's schema).
 * Any config change automatically flows to the tests — no duplicate to keep in sync.
 */

const PROXY_PORT = 18790;
const OPENCLAW_PORT = 18789;
const SUBAGENT_MODEL_NAME = "bedrock-agentcore-subagent";

function generateOpenClawConfig({ gatewayToken }) {
  const subagentModel = `agentcore/${SUBAGENT_MODEL_NAME}`;

  return {
    models: {
      providers: {
        agentcore: {
          baseUrl: `http://127.0.0.1:${PROXY_PORT}/v1`,
          apiKey: "local",
          api: "openai-completions",
          models: [
            { id: "bedrock-agentcore", name: "Bedrock AgentCore" },
            { id: SUBAGENT_MODEL_NAME, name: "Bedrock AgentCore Subagent" },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: "agentcore/bedrock-agentcore" },
        subagents: {
          model: subagentModel,
          maxConcurrent: 2,
          runTimeoutSeconds: 3600, // 1 hour — subagents handle long tasks (deep research, scraping)
          archiveAfterMinutes: 60,
        },
        sandbox: {
          mode: "off", // No Docker in AgentCore container; microVMs provide isolation
        },
      },
    },
    tools: {
      profile: "full",
      deny: [
        "apply_patch", // Code patching not needed for chat assistant
        "browser", // No headless browser in ARM64 container
        "canvas", // No UI rendering in headless chat context
        "cron", // EventBridge handles scheduling, not OpenClaw's built-in cron
        "gateway", // Admin tool — not needed for end users
        "message", // Channels are empty — file delivery uses [SEND_FILE:] markers via Router Lambda
      ],
    },
    skills: {
      allowBundled: [],
      load: { extraDirs: ["/skills"] },
    },
    gateway: {
      mode: "local",
      port: OPENCLAW_PORT,
      trustedProxies: ["127.0.0.1"],
      auth: { mode: "token", token: gatewayToken },
      controlUi: {
        enabled: true,
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
        dangerouslyAllowHostHeaderOriginFallback: true,
        allowedOrigins: ["*"],
      },
    },
    channels: {}, // No channels — messages bridged via WebSocket
  };
}

module.exports = { generateOpenClawConfig, PROXY_PORT, OPENCLAW_PORT, SUBAGENT_MODEL_NAME };
