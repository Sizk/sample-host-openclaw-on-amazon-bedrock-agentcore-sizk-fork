# Detailed Technical Architecture

This document provides a detailed technical view of the Custom Agent on AgentCore architecture. For a high-level overview, see the [README](../README.md#architecture).

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
            AGENT[Custom Agent]
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
    CONTRACT --> AGENT
    AGENT -->|via proxy| PROXY
    PROXY -->|ConverseStream| BEDROCK

    SCHED -->|trigger| CRONLAMBDA
    CRONLAMBDA -->|invoke| CONTRACT
    CRONLAMBDA -->|reply| TG & SL
```

## Component Details

| Component | Port | Purpose |
|---|---|---|
| **Contract Server** | 8080 | AgentCore HTTP contract (`/ping`, `/invocations`), lazy initialization, routes to custom agent |
| **Custom Agent** | — | Node.js agent with 14 built-in tools; agentic loop via proxy → Bedrock ConverseStream |
| **Bedrock Proxy** | 18790 | OpenAI-compatible API → Bedrock ConverseStream, Cognito identity, multimodal image handling |

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
    Note over RL,C: Typing indicator every 4s (Telegram)<br/>Progress message after 30s (both channels)

    opt First message (cold start)
        AC->>AC: STS AssumeRole (scoped S3 creds)
        AC->>AC: Start proxy + custom agent (~5s)
        AC->>S3: Restore .openclaw/ (background)
    end

    Note over AC,B: Custom agent handles message
    AC->>B: ConverseStream (via proxy)
    B-->>AC: Response

    AC-->>RL: Final response
    Note over RL: Unwrap nested content blocks<br/>Convert markdown → Telegram HTML
    RL->>C: Send message (HTML formatted)
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

```mermaid
flowchart TB
    subgraph MicroVM["AgentCore MicroVM (ARM64, per-user)"]
        CONTRACT["<b>Contract Server :8080</b><br/>GET /ping → Healthy<br/>POST /invocations<br/>Lazy init · SIGTERM save"]

        CONTRACT -->|"route messages"| AGENT

        subgraph AgentBox["Custom Agent"]
            AGENT["<b>custom-agent.js</b><br/>Agentic loop (20 iters)<br/>14 tools · SSRF protection<br/>Sub-agent support"]
        end

        PROXY["<b>Bedrock Proxy :18790</b><br/>OpenAI compat → ConverseStream<br/>Cognito identity · Multimodal images"]

        AGENT -->|"POST /v1/chat/completions"| PROXY
    end

    PROXY -->|ConverseStream| BEDROCK["Amazon Bedrock<br/>Claude"]

    S3[("S3<br/>workspace · files · images")]
    CONTRACT <-->|"restore / save<br/>.openclaw/"| S3
    AGENT -.->|"execFile<br/>skill scripts"| S3
```

### Custom Agent Tools

```mermaid
flowchart LR
    subgraph WebTools["In-Process (HTTP)"]
        WF["web_fetch<br/><i>Read web pages</i>"]
        WS["web_search<br/><i>DuckDuckGo HTML</i>"]
    end

    subgraph FileTools["Child Process (execFile)"]
        RF["read_user_file"]
        WUF["write_user_file"]
        LF["list_user_files"]
        DF["delete_user_file"]
    end

    subgraph CronTools["Child Process (execFile)"]
        CS["create_schedule"]
        LS["list_schedules"]
        US["update_schedule"]
        DS["delete_schedule"]
    end

    subgraph SSRF["SSRF Prevention"]
        BL["Hostname blocklist<br/><i>localhost, metadata, IMDS</i>"]
        DNS["Post-DNS IP check<br/><i>loopback, RFC-1918,<br/>RFC-6598, link-local,<br/>IPv6 ULA, IPv4-mapped</i>"]
        LIM["Limits: 512KB raw,<br/>50KB text, 15s timeout,<br/>3 redirects, 8 results"]
    end

    WF & WS --> BL --> DNS --> LIM
    FileTools -->|"/skills/s3-user-files/*.js"| S3[("S3")]
    CronTools -->|"/skills/eventbridge-cron/*.js"| EB["EventBridge<br/>Scheduler"]
```

### Startup Timeline

```mermaid
gantt
    title Cold Start Timeline
    dateFormat s
    axisFormat %S s

    section Container
    MicroVM created                     :done, t0, 0, 1s

    section Initialization
    Proxy + custom agent start (~5s)    :active, t1, 1s, 5s
    Workspace restore from S3           :done, t4, 1s, 10s

    section Ready
    Custom agent handles messages       :t5, 5s, 60s
```

**Ready** (t=~5s): Custom agent responds with 14 tools (web_fetch, web_search, 4 file, 4 cron, and more). All tools available immediately after startup.

### Custom Agent Architecture

The custom agent (`bridge/custom-agent.js`) provides the core AI agent functionality. It communicates with Bedrock via the proxy and executes tool calls using 14 built-in tools.

| Property | Detail |
|---|---|
| **Routing** | Calls proxy at `127.0.0.1:18790/v1/chat/completions` (OpenAI format) |
| **Agentic loop** | Up to 20 iterations of tool-call → tool-result → assistant-response |
| **Tools (14)** | `read_user_file`, `write_user_file`, `list_user_files`, `delete_user_file`, `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`, `web_fetch`, `web_search`, and more |
| **File/cron tools** | Execute skill scripts via `execFile` with isolated env vars |
| **Web tools** | In-process HTTP(S) with SSRF prevention (blocked IPs, DNS rebinding mitigation, redirect validation) |
| **SSRF protection** | Pre-connection hostname blocklist + post-DNS-resolution IP validation covering loopback, RFC-1918, RFC-6598, link-local (AWS IMDS), IPv6 ULA, IPv4-mapped IPv6 |
| **Sub-agents** | Native sub-agent calls running on the same AgentCore runtime |

## S3 Bucket Structure

```
s3://openclaw-user-files-{account}-{region}/
├── telegram_123456789/           # User namespace (channel_id)
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
- STS session-scoped S3 credentials (per-user namespace restriction)
- KMS encryption at rest
- Least-privilege IAM with cdk-nag enforcement
