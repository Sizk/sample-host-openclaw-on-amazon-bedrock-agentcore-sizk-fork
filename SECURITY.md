# Security

This document describes the security architecture and controls implemented in OpenClaw on AgentCore Runtime.

## Overview

This solution applies defense-in-depth across the network, application, identity, and data layers. The architecture assumes a zero-trust model where each component has minimal permissions and all communication is authenticated and encrypted.

## Network Security

### VPC Isolation

AgentCore containers run in **private VPC subnets** with no direct internet exposure. All AWS service access goes through VPC endpoints:

- S3 (Gateway endpoint)
- Secrets Manager (Interface endpoint)
- Bedrock Runtime (Interface endpoint)
- ECR (Interface endpoints for API and DKR)
- CloudWatch Logs (Interface endpoint)
- STS (Interface endpoint)
- DynamoDB (Gateway endpoint)

The **only public entry point** is the API Gateway HTTP API, which handles webhook ingestion from Telegram and Slack.

### API Surface Minimization

The API Gateway exposes only three explicit routes:

| Route | Method | Purpose |
|---|---|---|
| `/webhook/telegram` | POST | Telegram webhook ingestion |
| `/webhook/slack` | POST | Slack Events API ingestion |
| `/health` | GET | Health check endpoint |

All other paths return 404 from API Gateway itself **without invoking the Lambda**. This prevents path enumeration and reduces attack surface.

### Rate Limiting

API Gateway applies rate limiting to prevent DDoS attacks:
- **Burst**: 50 requests
- **Sustained**: 100 requests/second

## Authentication & Authorization

### Webhook Authentication

Every incoming webhook request is **cryptographically validated** before processing:

**Telegram**:
- Validates the `X-Telegram-Bot-Api-Secret-Token` header
- Secret is registered with Telegram via the `secret_token` parameter on `setWebhook`
- Requests without valid token are rejected with 401

**Slack**:
- Validates the `X-Slack-Signature` HMAC-SHA256 header
- Uses the Slack app's signing secret for verification
- Includes 5-minute timestamp check to prevent replay attacks
- Requests with invalid signature or expired timestamp are rejected

**Fail-closed**: Requests are rejected if secrets are not configured in Secrets Manager.

### Per-User Isolation

Each user runs in their own **AgentCore microVM** with a dedicated S3 namespace:

- User A's files: `s3://bucket/telegram_123456/...`
- User B's files: `s3://bucket/slack_789012/...`

There is **no shared state** between users. Namespace derivation is system-controlled (from the channel identity) and cannot be influenced by user input.

### Identity Management

**Cognito User Pool** provides per-user identity:
- Users are auto-provisioned by the proxy via `AdminCreateUser`
- Passwords are HMAC-derived: `HMAC-SHA256(secret, actorId).slice(0, 32)`
- Passwords are deterministic and never stored
- JWT tokens are cached per user with 60-second early refresh

**AgentCore WorkloadIdentity** integrates with Cognito OIDC for JWT-based authentication between the container and AWS services.

### Least-Privilege IAM

Each component has tightly scoped permissions:

| Component | Permissions |
|---|---|
| Router Lambda | Invoke specific AgentCore Runtime only (not `Resource: *`) |
| Router Lambda | Cognito operations scoped to specific user pool |
| Router Lambda | Secrets Manager access limited to `openclaw/*` prefix |
| AgentCore Container | S3 access scoped to user-files bucket |
| AgentCore Container | Bedrock invoke scoped to specific model/inference profile |

## Data Protection

### Encryption at Rest

| Service | Encryption |
|---|---|
| S3 | KMS with customer-managed key (CMK) |
| DynamoDB | AWS-managed keys |
| Secrets Manager | Customer-managed KMS key |
| CloudWatch Logs | AWS-managed keys |

### Encryption in Transit

- **TLS** for all AWS API calls
- **HTTPS** for API Gateway (TLS 1.2+)
- **HTTPS** for Telegram/Slack webhook delivery
- **HTTPS** for outbound API calls (Telegram sendMessage, Slack chat.postMessage)

### Secret Management

All sensitive values are stored in **AWS Secrets Manager** encrypted with a customer-managed KMS key:

| Secret | Purpose |
|---|---|
| `openclaw/channels/telegram` | Telegram bot token |
| `openclaw/channels/slack` | Slack bot token + signing secret (JSON) |
| `openclaw/webhook-secret` | Webhook validation token |
| `openclaw/gateway-token` | OpenClaw gateway authentication |
| `openclaw/cognito-secret` | HMAC secret for password derivation |

Secrets are:
- Fetched at runtime and held in process memory only
- Never written to environment variables, config files, or logs
- Rotated via Secrets Manager (manual rotation supported)

## Container Security

### Hardening Measures

- Request body size limited to **1MB** to prevent memory exhaustion
- Internal error details and stack traces are **never exposed** in API responses
- Container runs on AgentCore's **Firecracker microVM** with hardware-level isolation
- Each user session runs in a **separate microVM** (not shared containers)

### Image Security

- Base image: `node:22-slim` (minimal attack surface)
- Platform: `linux/arm64` (Graviton, reduced vulnerability exposure)
- Dependencies: Only required npm packages installed
- No secrets baked into image

## Audit & Compliance

### CloudTrail

Full audit trail of API activity across all AWS services, including:
- Bedrock model invocations
- Secrets Manager access
- S3 object operations
- DynamoDB operations
- Lambda invocations

### Observability

CloudWatch dashboards and alarms monitor:
- Lambda errors, latency, and throttling
- API Gateway 4xx/5xx error rates
- Bedrock invocation metrics
- Token usage per user (custom metrics)
- Budget alarms for cost control

### Automated Compliance

Every `cdk synth` runs [cdk-nag](https://github.com/cdklabs/cdk-nag) AwsSolutions checks against the entire infrastructure:

```bash
cdk synth  # Runs security checks automatically
```

This catches common misconfigurations before deployment:
- S3 bucket public access
- Unencrypted resources
- Overly permissive IAM policies
- Missing logging configurations

## Reporting Security Issues

See [CONTRIBUTING.md](CONTRIBUTING.md#security-issue-notifications) for information on reporting security vulnerabilities.
