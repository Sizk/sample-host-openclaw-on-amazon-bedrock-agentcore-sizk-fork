# Detailed Technical Architecture

This document provides a detailed technical view of the OpenClaw on AgentCore architecture. For a high-level overview, see the [README](../README.md#architecture).

## Component Diagram

```mermaid
flowchart TB
    subgraph Channels
        TG[Telegram]
        SL[Slack]
    end

    subgraph AWS
        APIGW[API Gateway]

        subgraph Router[Router Lambda]
            WH[Webhook Handler]
            UR[User Resolution]
        end

        DDB[(DynamoDB)]
        S3[(S3)]

        subgraph AgentCore[AgentCore Runtime]
            CONTRACT[Contract :8080]
            PROXY[Proxy :18790]
            OPENCLAW[OpenClaw :18789]
        end

        BEDROCK[Bedrock Claude]

        subgraph Cron[EventBridge Scheduler]
            SCHED[Schedules]
            CRONLAMBDA[Cron Executor Lambda]
        end
    end

    TG & SL -->|webhook| APIGW
    APIGW --> WH
    WH --> UR
    UR <-->|identity| DDB
    UR -->|images| S3
    UR -->|invoke| CONTRACT
    CONTRACT <-->|workspace| S3
    CONTRACT --> PROXY
    CONTRACT <-->|WebSocket| OPENCLAW
    PROXY -->|ConverseStream| BEDROCK

    SCHED -->|trigger| CRONLAMBDA
    CRONLAMBDA -->|invoke| CONTRACT
    CRONLAMBDA -->|reply| TG & SL
```

## Component Details

| Component | Port | Purpose |
|---|---|---|
| **Contract Server** | 8080 | AgentCore HTTP contract (`/ping`, `/invocations`), lazy initialization, WebSocket bridge |
| **Bedrock Proxy** | 18790 | OpenAI-compatible API → Bedrock ConverseStream, Cognito identity, multimodal image handling |
| **OpenClaw Gateway** | 18789 | Headless AI agent with tools and skills |

## Data Flow

### Message Flow (User → Agent → Response)

```mermaid
sequenceDiagram
    participant U as User
    participant C as Channel
    participant AG as API Gateway
    participant RL as Router Lambda
    participant DB as DynamoDB
    participant S3 as S3
    participant AC as AgentCore
    participant B as Bedrock

    U->>C: Send message
    C->>AG: Webhook POST
    AG->>RL: Invoke
    RL-->>C: 200 OK (immediate)
    RL->>RL: Self-invoke async
    RL->>DB: Resolve user identity

    opt Has image
        RL->>C: Download image
        RL->>S3: Upload to _uploads/
    end

    RL->>AC: InvokeAgentRuntime

    opt First message (cold start)
        AC->>S3: Restore .openclaw/
        AC->>AC: Start proxy + OpenClaw (~4 min)
    end

    AC->>B: ConverseStream
    B-->>AC: Streaming response
    AC-->>RL: Final response
    RL->>C: Send message
    C->>U: Display response
```

### Cron Job Flow (Scheduled Task)

```mermaid
sequenceDiagram
    participant EB as EventBridge
    participant CL as Cron Lambda
    participant AC as AgentCore
    participant B as Bedrock
    participant C as Channel

    EB->>CL: Scheduled trigger
    CL->>AC: Warmup request
    AC-->>CL: Ready
    CL->>AC: Send cron message
    AC->>B: ConverseStream
    B-->>AC: Response
    AC-->>CL: Final response
    CL->>C: Deliver to user
```

### Cross-Channel Account Linking

```mermaid
sequenceDiagram
    participant U as User
    participant TG as Telegram
    participant SL as Slack
    participant RL as Router Lambda
    participant DB as DynamoDB

    U->>TG: "link"
    TG->>RL: Webhook
    RL->>DB: Create BIND#ABC123 (10 min TTL)
    RL->>TG: "Code: ABC123"
    TG->>U: Display code

    U->>SL: "link ABC123"
    SL->>RL: Webhook
    RL->>DB: Lookup BIND#ABC123
    RL->>DB: Create CHANNEL#slack:U123 → same userId
    RL->>DB: Delete BIND#ABC123
    RL->>SL: "Accounts linked!"
    SL->>U: Confirmation
```

## Container Internals

```
┌─────────────────────────────────────────────────────────────────┐
│  AgentCore MicroVM (ARM64, per-user)                            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Contract Server (:8080)                                 │   │
│  │  - GET /ping → Healthy                                   │   │
│  │  - POST /invocations {action: chat|warmup|status|cron}   │   │
│  │  - Lazy init: restore workspace, start proxy + OpenClaw  │   │
│  │  - SIGTERM: save workspace, cleanup                      │   │
│  └──────────────────────┬──────────────────────────────────┘   │
│                         │                                       │
│         ┌───────────────┴───────────────┐                      │
│         │                               │                      │
│  ┌──────▼──────┐              ┌─────────▼─────────┐            │
│  │ Proxy       │              │ OpenClaw Gateway  │            │
│  │ (:18790)    │◄────────────►│ (:18789)          │            │
│  │             │  WebSocket   │                   │            │
│  │ - OpenAI    │              │ - Headless mode   │            │
│  │   compat    │              │ - Full tools      │            │
│  │ - Bedrock   │              │ - Custom skills   │            │
│  │   Converse  │              │   - s3-user-files │            │
│  │ - Cognito   │              │   - eventbridge-  │            │
│  │   identity  │              │     cron          │            │
│  └──────┬──────┘              └───────────────────┘            │
│         │                                                       │
└─────────┼───────────────────────────────────────────────────────┘
          │
          ▼
    Amazon Bedrock
    ConverseStream API
```

## S3 Bucket Structure

```
s3://openclaw-user-files-{account}-{region}/
├── telegram_6087229962/           # User namespace (channel_id)
│   ├── .openclaw/                 # Workspace (synced on init/shutdown)
│   │   ├── openclaw.json
│   │   ├── MEMORY.md
│   │   ├── USER.md
│   │   └── ...
│   ├── _uploads/                  # Image uploads (from Router Lambda)
│   │   ├── img_1709012345_a1b2.jpeg
│   │   └── ...
│   └── documents/                 # User files (via s3-user-files skill)
│       └── notes.md
├── slack_U12345678/
│   └── ...
└── ...
```

## DynamoDB Schema

**Table: `openclaw-identity`**

| PK | SK | Purpose | TTL |
|---|---|---|---|
| `CHANNEL#telegram:123` | `PROFILE` | Channel → userId mapping | - |
| `USER#user_abc` | `PROFILE` | User profile | - |
| `USER#user_abc` | `CHANNEL#telegram:123` | User's bound channels | - |
| `USER#user_abc` | `SESSION` | Current AgentCore session ID | - |
| `USER#user_abc` | `CRON#reminder-1` | Cron schedule metadata | - |
| `BIND#ABC123` | `BIND` | Cross-channel bind code | 10 min |
| `ALLOW#telegram:123` | `ALLOW` | User allowlist entry | - |

## Security Architecture

See [SECURITY.md](../SECURITY.md) for comprehensive security documentation.

**Key controls:**
- VPC isolation with 7 VPC endpoints
- Webhook signature validation (Telegram + Slack)
- Per-user microVM isolation
- KMS encryption at rest
- Least-privilege IAM with cdk-nag enforcement
