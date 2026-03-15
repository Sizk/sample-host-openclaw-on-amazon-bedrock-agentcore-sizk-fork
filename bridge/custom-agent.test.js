/**
 * Tests for custom-agent.js — the full-featured agent for AgentCore Runtime.
 *
 * Tests cover:
 *   - Tool definitions (schema validation)
 *   - Tool argument building (SCRIPT_MAP integration)
 *   - Exec tool (command execution)
 *   - Read file tool (path validation)
 *   - Web fetch (SSRF prevention)
 *   - Web search (query validation)
 *   - Context trimming (history management)
 *   - Chat function (agent loop with mocked proxy)
 *   - Sub-agent tool sets
 *   - Environment configuration
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const agent = require("./custom-agent");

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe("TOOLS", () => {
  it("contains all 14 expected tools", () => {
    const names = agent.TOOLS.map((t) => t.function.name);
    assert.deepStrictEqual(names.sort(), [
      "create_schedule",
      "delete_schedule",
      "delete_user_file",
      "exec",
      "list_schedules",
      "list_user_files",
      "read_file",
      "read_user_file",
      "spawn_subagents",
      "update_schedule",
      "web_fetch",
      "web_search",
      "write_user_file",
    ].sort());
  });

  it("every tool has valid OpenAI function-calling schema", () => {
    for (const tool of agent.TOOLS) {
      assert.equal(tool.type, "function", `${tool.function?.name} has type=function`);
      assert.ok(tool.function.name, "tool has name");
      assert.ok(tool.function.description, `${tool.function.name} has description`);
      assert.ok(tool.function.parameters, `${tool.function.name} has parameters`);
      assert.equal(tool.function.parameters.type, "object", `${tool.function.name} params is object`);
    }
  });

  it("exec requires command", () => {
    const exec = agent.TOOLS.find((t) => t.function.name === "exec");
    assert.deepStrictEqual(exec.function.parameters.required, ["command"]);
  });

  it("read_file requires path", () => {
    const rf = agent.TOOLS.find((t) => t.function.name === "read_file");
    assert.deepStrictEqual(rf.function.parameters.required, ["path"]);
  });

  it("spawn_subagents requires tasks array", () => {
    const sa = agent.TOOLS.find((t) => t.function.name === "spawn_subagents");
    assert.deepStrictEqual(sa.function.parameters.required, ["tasks"]);
  });

  it("write_user_file requires only filename", () => {
    const wuf = agent.TOOLS.find((t) => t.function.name === "write_user_file");
    assert.deepStrictEqual(wuf.function.parameters.required, ["filename"]);
  });
});

// ---------------------------------------------------------------------------
// SCRIPT_MAP
// ---------------------------------------------------------------------------

describe("SCRIPT_MAP", () => {
  it("has entries for skill-backed tools", () => {
    const skillTools = [
      "read_user_file", "write_user_file", "list_user_files", "delete_user_file",
      "create_schedule", "list_schedules", "update_schedule", "delete_schedule",
    ];
    for (const name of skillTools) {
      assert.ok(agent.SCRIPT_MAP[name], `SCRIPT_MAP has ${name}`);
    }
  });

  it("cron scripts point to /skills/eventbridge-cron/", () => {
    const cronTools = ["create_schedule", "list_schedules", "update_schedule", "delete_schedule"];
    for (const name of cronTools) {
      assert.ok(agent.SCRIPT_MAP[name].includes("/skills/eventbridge-cron/"), `${name} points to cron dir`);
    }
  });

  it("s3 scripts point to /skills/s3-user-files/", () => {
    const s3Tools = ["read_user_file", "write_user_file", "list_user_files", "delete_user_file"];
    for (const name of s3Tools) {
      assert.ok(agent.SCRIPT_MAP[name].includes("/skills/s3-user-files/"), `${name} points to s3 dir`);
    }
  });

  it("does not have entries for in-process tools", () => {
    assert.equal(agent.SCRIPT_MAP["exec"], undefined);
    assert.equal(agent.SCRIPT_MAP["read_file"], undefined);
    assert.equal(agent.SCRIPT_MAP["web_fetch"], undefined);
    assert.equal(agent.SCRIPT_MAP["web_search"], undefined);
    assert.equal(agent.SCRIPT_MAP["spawn_subagents"], undefined);
  });
});

// ---------------------------------------------------------------------------
// TOOL_ENV
// ---------------------------------------------------------------------------

describe("TOOL_ENV", () => {
  it("includes base env vars", () => {
    assert.ok("PATH" in agent.TOOL_ENV);
    assert.ok("HOME" in agent.TOOL_ENV);
    assert.ok("AWS_REGION" in agent.TOOL_ENV);
    assert.ok("NODE_PATH" in agent.TOOL_ENV);
  });

  it("includes cron env vars", () => {
    assert.ok("EVENTBRIDGE_SCHEDULE_GROUP" in agent.TOOL_ENV);
    assert.ok("CRON_LAMBDA_ARN" in agent.TOOL_ENV);
    assert.ok("EVENTBRIDGE_ROLE_ARN" in agent.TOOL_ENV);
    assert.ok("IDENTITY_TABLE_NAME" in agent.TOOL_ENV);
  });
});

// ---------------------------------------------------------------------------
// buildToolArgs
// ---------------------------------------------------------------------------

describe("buildToolArgs", () => {
  it("returns null for unknown tool", () => {
    assert.equal(agent.buildToolArgs("nonexistent", {}, "user1"), null);
  });

  it("returns null for in-process tools", () => {
    assert.equal(agent.buildToolArgs("exec", {}, "user1"), null);
    assert.equal(agent.buildToolArgs("web_fetch", {}, "user1"), null);
    assert.equal(agent.buildToolArgs("web_search", {}, "user1"), null);
  });

  it("read_user_file: script, userId, filename", () => {
    const args = agent.buildToolArgs("read_user_file", { filename: "test.md" }, "user1");
    assert.deepStrictEqual(args, [agent.SCRIPT_MAP.read_user_file, "user1", "test.md"]);
  });

  it("list_user_files: script, userId only", () => {
    const args = agent.buildToolArgs("list_user_files", {}, "user1");
    assert.deepStrictEqual(args, [agent.SCRIPT_MAP.list_user_files, "user1"]);
  });

  it("delete_user_file: script, userId, filename", () => {
    const args = agent.buildToolArgs("delete_user_file", { filename: "old.txt" }, "user1");
    assert.deepStrictEqual(args, [agent.SCRIPT_MAP.delete_user_file, "user1", "old.txt"]);
  });

  it("create_schedule: positional args", () => {
    const args = agent.buildToolArgs("create_schedule", {
      cron_expression: "cron(0 9 * * ? *)",
      timezone: "UTC",
      message: "hello",
    }, "user1");
    assert.deepStrictEqual(args, [
      agent.SCRIPT_MAP.create_schedule, "user1",
      "cron(0 9 * * ? *)", "UTC", "hello",
    ]);
  });

  it("create_schedule: includes schedule_name with placeholders", () => {
    const args = agent.buildToolArgs("create_schedule", {
      cron_expression: "cron(0 9 * * ? *)",
      timezone: "UTC",
      message: "hello",
      schedule_name: "morning",
    }, "user1");
    assert.deepStrictEqual(args, [
      agent.SCRIPT_MAP.create_schedule, "user1",
      "cron(0 9 * * ? *)", "UTC", "hello", "", "", "morning",
    ]);
  });

  it("update_schedule: minimal (schedule_id only)", () => {
    const args = agent.buildToolArgs("update_schedule", { schedule_id: "abc123" }, "user1");
    assert.deepStrictEqual(args, [agent.SCRIPT_MAP.update_schedule, "user1", "abc123"]);
  });

  it("update_schedule: all optional flags", () => {
    const args = agent.buildToolArgs("update_schedule", {
      schedule_id: "abc123",
      expression: "cron(0 10 * * ? *)",
      timezone: "UTC",
      message: "updated",
      name: "new-name",
    }, "user1");
    assert.ok(args.includes("--expression"));
    assert.ok(args.includes("--timezone"));
    assert.ok(args.includes("--message"));
    assert.ok(args.includes("--name"));
  });

  it("update_schedule: --enable flag", () => {
    const args = agent.buildToolArgs("update_schedule", { schedule_id: "x", enable: true }, "user1");
    assert.ok(args.includes("--enable"));
    assert.ok(!args.includes("--disable"));
  });

  it("update_schedule: --disable flag", () => {
    const args = agent.buildToolArgs("update_schedule", { schedule_id: "x", disable: true }, "user1");
    assert.ok(args.includes("--disable"));
    assert.ok(!args.includes("--enable"));
  });

  it("delete_schedule: script, userId, schedule_id", () => {
    const args = agent.buildToolArgs("delete_schedule", { schedule_id: "abc123" }, "user1");
    assert.deepStrictEqual(args, [agent.SCRIPT_MAP.delete_schedule, "user1", "abc123"]);
  });
});

// ---------------------------------------------------------------------------
// executeExec
// ---------------------------------------------------------------------------

describe("executeExec", () => {
  it("executes a simple echo command", async () => {
    const result = await agent.executeExec("echo hello");
    assert.ok(result.includes("hello"));
  });

  it("captures stderr", async () => {
    const result = await agent.executeExec("echo error >&2");
    assert.ok(result.includes("STDERR:"));
    assert.ok(result.includes("error"));
  });

  it("reports non-zero exit code", async () => {
    const result = await agent.executeExec("exit 42");
    assert.ok(result.includes("Exit code: 42"));
  });

  it("returns output for successful command", async () => {
    const result = await agent.executeExec("echo 'line1'; echo 'line2'");
    assert.ok(result.includes("line1"));
    assert.ok(result.includes("line2"));
  });

  it("handles commands that produce no output", async () => {
    const result = await agent.executeExec("true");
    assert.equal(result, "(no output)");
  });
});

// ---------------------------------------------------------------------------
// executeReadFile
// ---------------------------------------------------------------------------

describe("executeReadFile", () => {
  const tmpFile = "/tmp/test-custom-agent-read.txt";

  beforeEach(() => {
    fs.writeFileSync(tmpFile, "test content here\n");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("reads a file from /tmp", async () => {
    const result = await agent.executeReadFile(tmpFile);
    assert.ok(result.includes("test content here"));
  });

  it("returns error for non-existent file", async () => {
    const result = await agent.executeReadFile("/tmp/nonexistent-file-abc123.txt");
    assert.ok(result.includes("Error:"));
  });

  it("rejects access to /etc", async () => {
    const result = await agent.executeReadFile("/etc/passwd");
    assert.ok(result.includes("Access denied"));
  });

  it("allows /app directory", async () => {
    // /app may not exist locally but the validation logic should not block it
    const result = await agent.executeReadFile("/app/nonexistent.js");
    // Should either error with file not found (not access denied)
    assert.ok(!result.includes("Access denied"));
  });

  it("allows /skills directory", async () => {
    const result = await agent.executeReadFile("/skills/nonexistent.js");
    assert.ok(!result.includes("Access denied"));
  });
});

// ---------------------------------------------------------------------------
// SSRF prevention (validateUrlSafety)
// ---------------------------------------------------------------------------

describe("validateUrlSafety", () => {
  it("allows valid HTTP URLs", () => {
    assert.equal(agent.validateUrlSafety("https://example.com"), null);
    assert.equal(agent.validateUrlSafety("http://example.com"), null);
  });

  it("rejects empty URL", () => {
    assert.ok(agent.validateUrlSafety("") !== null);
    assert.ok(agent.validateUrlSafety(null) !== null);
  });

  it("rejects non-http protocols", () => {
    assert.ok(agent.validateUrlSafety("ftp://example.com") !== null);
    assert.ok(agent.validateUrlSafety("file:///etc/passwd") !== null);
  });

  it("rejects localhost", () => {
    assert.ok(agent.validateUrlSafety("http://localhost") !== null);
    assert.ok(agent.validateUrlSafety("http://localhost:8080") !== null);
  });

  it("rejects 127.x.x.x addresses", () => {
    assert.ok(agent.validateUrlSafety("http://127.0.0.1") !== null);
    assert.ok(agent.validateUrlSafety("http://127.0.0.1:8080") !== null);
  });

  it("rejects private IP ranges", () => {
    assert.ok(agent.validateUrlSafety("http://10.0.0.1") !== null);
    assert.ok(agent.validateUrlSafety("http://192.168.1.1") !== null);
    assert.ok(agent.validateUrlSafety("http://172.16.0.1") !== null);
  });

  it("rejects AWS metadata endpoint", () => {
    assert.ok(agent.validateUrlSafety("http://169.254.169.254") !== null);
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    assert.equal(agent.stripHtml("<p>hello</p>"), "hello");
  });

  it("removes script tags with content", () => {
    const html = '<p>text</p><script>alert("xss")</script><p>more</p>';
    const result = agent.stripHtml(html);
    assert.ok(!result.includes("alert"));
    assert.ok(result.includes("text"));
    assert.ok(result.includes("more"));
  });

  it("decodes HTML entities", () => {
    assert.equal(agent.stripHtml("a &amp; b"), "a & b");
    assert.equal(agent.stripHtml("&lt;tag&gt;"), "<tag>");
  });

  it("collapses whitespace", () => {
    const result = agent.stripHtml("<p>  lots   of   spaces  </p>");
    assert.equal(result, "lots of spaces");
  });

  it("returns empty string for empty input", () => {
    assert.equal(agent.stripHtml(""), "");
    assert.equal(agent.stripHtml(null), "");
  });
});

// ---------------------------------------------------------------------------
// parseSearchResults
// ---------------------------------------------------------------------------

describe("parseSearchResults", () => {
  it("returns no results for empty HTML", () => {
    assert.equal(agent.parseSearchResults(""), "No results found.");
    assert.equal(agent.parseSearchResults(null), "No results found.");
  });

  it("returns no results for HTML without search results", () => {
    assert.equal(agent.parseSearchResults("<html><body>nothing</body></html>"), "No results found.");
  });
});

// ---------------------------------------------------------------------------
// Context trimming
// ---------------------------------------------------------------------------

describe("context trimming", () => {
  beforeEach(() => {
    agent.conversationHistory.length = 0;
  });

  it("estimateHistorySize returns 0 for empty history", () => {
    assert.equal(agent.estimateHistorySize(), 0);
  });

  it("estimateHistorySize counts string content", () => {
    agent.conversationHistory.push({ role: "system", content: "12345" });
    assert.equal(agent.estimateHistorySize(), 5);
  });

  it("estimateHistorySize counts tool_calls arguments", () => {
    agent.conversationHistory.push({
      role: "assistant",
      tool_calls: [{ function: { name: "exec", arguments: '{"command":"echo hi"}' } }],
    });
    assert.ok(agent.estimateHistorySize() > 20);
  });

  it("trimHistory removes oldest messages when over limit", () => {
    // Fill history beyond MAX_CONTEXT_CHARS
    agent.conversationHistory.push({ role: "system", content: "system prompt" });
    for (let i = 0; i < 100; i++) {
      agent.conversationHistory.push({ role: "user", content: "x".repeat(10000) });
    }
    // Total ~1M chars, well over MAX_CONTEXT_CHARS (600K)
    const sizeBefore = agent.estimateHistorySize();
    agent.trimHistory();
    const sizeAfter = agent.estimateHistorySize();
    assert.ok(sizeAfter < sizeBefore, "history should be smaller after trim");
    assert.ok(sizeAfter <= agent.MAX_CONTEXT_CHARS, "should be under limit");
    assert.ok(agent.conversationHistory.length >= agent.MIN_KEEP_MESSAGES, "should keep minimum messages");
  });

  it("trimHistory preserves system prompt (index 0)", () => {
    agent.conversationHistory.push({ role: "system", content: "keep me" });
    for (let i = 0; i < 100; i++) {
      agent.conversationHistory.push({ role: "user", content: "x".repeat(10000) });
    }
    agent.trimHistory();
    assert.equal(agent.conversationHistory[0].role, "system");
    assert.equal(agent.conversationHistory[0].content, "keep me");
  });

  it("resetHistory clears all messages", () => {
    agent.conversationHistory.push({ role: "system", content: "test" });
    agent.conversationHistory.push({ role: "user", content: "test" });
    agent.resetHistory();
    assert.equal(agent.conversationHistory.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent tool sets
// ---------------------------------------------------------------------------

describe("SUBAGENT_TOOL_SETS", () => {
  it("has 5 tool set types", () => {
    const types = Object.keys(agent.SUBAGENT_TOOL_SETS);
    assert.deepStrictEqual(types.sort(), [
      "data_processing", "finance", "general", "research", "web_scraping",
    ]);
  });

  it("all tool sets include exec and read_file", () => {
    for (const [name, tools] of Object.entries(agent.SUBAGENT_TOOL_SETS)) {
      assert.ok(tools.includes("exec"), `${name} includes exec`);
      assert.ok(tools.includes("read_file") || tools.includes("read_user_file"),
        `${name} includes read capability`);
    }
  });

  it("web_scraping includes web_search but NOT web_fetch (force Puppeteer)", () => {
    const tools = agent.SUBAGENT_TOOL_SETS.web_scraping;
    assert.ok(!tools.includes("web_fetch"), "web_scraping should NOT include web_fetch");
    assert.ok(tools.includes("web_search"));
    assert.ok(tools.includes("exec"), "web_scraping must include exec for Puppeteer scripts");
  });

  it("general has the most tools", () => {
    const generalCount = agent.SUBAGENT_TOOL_SETS.general.length;
    for (const [name, tools] of Object.entries(agent.SUBAGENT_TOOL_SETS)) {
      assert.ok(tools.length <= generalCount, `${name} (${tools.length}) <= general (${generalCount})`);
    }
  });

  it("no tool set includes spawn_subagents (prevent recursion)", () => {
    for (const [name, tools] of Object.entries(agent.SUBAGENT_TOOL_SETS)) {
      assert.ok(!tools.includes("spawn_subagents"), `${name} should not include spawn_subagents`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSubagentSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSubagentSystemPrompt", () => {
  it("is a function", () => {
    assert.equal(typeof agent.buildSubagentSystemPrompt, "function");
  });

  it("always includes base context and task description", () => {
    const result = agent.buildSubagentSystemPrompt("Scrape fotocasa.es", "web_scraping");
    assert.ok(result.includes("You are a sub-agent"), "has sub-agent identity");
    assert.ok(result.includes("NEVER expose internal details"), "has internal details rule");
    assert.ok(result.includes("[SEND_FILE:filename]"), "has file delivery rule");
    assert.ok(result.includes("Scrape fotocasa.es"), "has task description");
    assert.ok(result.includes("YOUR TASK"), "has task header");
    assert.ok(result.includes("EFFICIENCY"), "has efficiency section");
    assert.ok(result.includes("limited context"), "warns about context limits");
  });

  it("includes scraping context for web_scraping tool set", () => {
    const result = agent.buildSubagentSystemPrompt("Scrape site", "web_scraping");
    assert.ok(result.includes("ws://127.0.0.1:9222"), "has Lightpanda endpoint");
    assert.ok(result.includes("puppeteer"), "has Puppeteer reference");
    assert.ok(result.includes("Scrapling"), "has Scrapling reference");
    assert.ok(result.includes("NEVER kill"), "forbids killing Lightpanda");
    assert.ok(result.includes("body.innerText"), "forbids raw innerText dumps");
    assert.ok(result.includes("targeted CSS selectors"), "promotes targeted extraction");
  });

  it("includes scraping context for research tool set", () => {
    const result = agent.buildSubagentSystemPrompt("Research topic", "research");
    assert.ok(result.includes("ws://127.0.0.1:9222"), "research gets scraping context");
    assert.ok(result.includes("Puppeteer"), "research gets Puppeteer");
  });

  it("includes scraping context for finance tool set", () => {
    const result = agent.buildSubagentSystemPrompt("Get stock data", "finance");
    assert.ok(result.includes("ws://127.0.0.1:9222"), "finance gets scraping context");
  });

  it("includes scraping context for general tool set", () => {
    const result = agent.buildSubagentSystemPrompt("Do stuff", "general");
    assert.ok(result.includes("ws://127.0.0.1:9222"), "general gets scraping context");
  });

  it("does NOT include scraping context for data_processing", () => {
    const result = agent.buildSubagentSystemPrompt("Process CSV", "data_processing");
    assert.ok(!result.includes("ws://127.0.0.1:9222"), "data_processing has no scraping");
    assert.ok(!result.includes("Puppeteer"), "data_processing has no Puppeteer");
  });

  it("includes data/file context for data_processing", () => {
    const result = agent.buildSubagentSystemPrompt("Make chart", "data_processing");
    assert.ok(result.includes("matplotlib"), "data_processing has matplotlib");
    assert.ok(result.includes("openpyxl"), "data_processing has openpyxl");
  });

  it("includes data/file context for finance", () => {
    const result = agent.buildSubagentSystemPrompt("Chart portfolio", "finance");
    assert.ok(result.includes("matplotlib"), "finance gets file generation context");
  });

  it("includes data/file context for general", () => {
    const result = agent.buildSubagentSystemPrompt("Generate report", "general");
    assert.ok(result.includes("matplotlib"), "general gets file generation context");
  });

  it("does NOT include data/file context for web_scraping", () => {
    const result = agent.buildSubagentSystemPrompt("Scrape site", "web_scraping");
    assert.ok(!result.includes("matplotlib"), "web_scraping has no file generation context");
  });

  it("does NOT include data/file context for research", () => {
    const result = agent.buildSubagentSystemPrompt("Research topic", "research");
    assert.ok(!result.includes("matplotlib"), "research has no file generation context");
  });

  it("task description appears at the end after separator", () => {
    const result = agent.buildSubagentSystemPrompt("My specific task here", "general");
    const taskIdx = result.indexOf("My specific task here");
    const sepIdx = result.indexOf("YOUR TASK");
    assert.ok(sepIdx < taskIdx, "separator comes before task");
    assert.ok(sepIdx > 0, "separator exists");
  });

  it("defaults gracefully for unknown tool set (base context only)", () => {
    const result = agent.buildSubagentSystemPrompt("Unknown set task", "unknown_set");
    assert.ok(result.includes("You are a sub-agent"), "has base context");
    assert.ok(result.includes("Unknown set task"), "has task description");
    assert.ok(!result.includes("ws://127.0.0.1:9222"), "no scraping for unknown set");
    assert.ok(!result.includes("matplotlib"), "no file gen for unknown set");
  });
});

// ---------------------------------------------------------------------------
// subagentStatus and getSubagentStatus
// ---------------------------------------------------------------------------

describe("subagentStatus", () => {
  it("is initially inactive", () => {
    assert.equal(agent.subagentStatus.active, false);
    assert.deepStrictEqual(agent.subagentStatus.agents, []);
  });

  it("getSubagentStatus returns null when inactive", () => {
    agent.subagentStatus.active = false;
    assert.equal(agent.getSubagentStatus(), null);
  });

  it("getSubagentStatus returns snapshot when active", () => {
    agent.subagentStatus.active = true;
    agent.subagentStatus.startedAt = Date.now() - 5000;
    agent.subagentStatus.mainTask = "Scrape 100 websites";
    agent.subagentStatus.agents = [
      { id: 1, toolSet: "web_scraping", description: "Scrape batch 1", iteration: 3, maxIterations: 15, lastTool: "web_fetch", lastToolArg: "https://example.com", status: "running" },
      { id: 2, toolSet: "web_scraping", description: "Scrape batch 2", iteration: 7, maxIterations: 15, lastTool: "exec", lastToolArg: "node puppeteer.js", status: "running" },
    ];
    const snapshot = agent.getSubagentStatus();
    assert.ok(snapshot.active);
    assert.ok(snapshot.elapsedSeconds >= 4 && snapshot.elapsedSeconds <= 10);
    assert.equal(snapshot.agents.length, 2);
    assert.equal(snapshot.agents[0].iteration, 3);
    assert.equal(snapshot.agents[1].lastTool, "exec");
    assert.equal(snapshot.mainTask, "Scrape 100 websites");

    // Verify it's a snapshot (modifying it doesn't affect original)
    snapshot.agents[0].iteration = 999;
    assert.equal(agent.subagentStatus.agents[0].iteration, 3);

    // Clean up
    agent.subagentStatus.active = false;
    agent.subagentStatus.agents = [];
    agent.subagentStatus.mainTask = "";
  });
});

// ---------------------------------------------------------------------------
// setExecEnv
// ---------------------------------------------------------------------------

describe("setExecEnv", () => {
  it("is a function", () => {
    assert.equal(typeof agent.setExecEnv, "function");
  });

  it("does not throw when called", () => {
    assert.doesNotThrow(() => {
      agent.setExecEnv({ AWS_CONFIG_FILE: "/tmp/test", AWS_SDK_LOAD_CONFIG: "1" });
    });
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("MAX_ITERATIONS is reasonable", () => {
    assert.ok(agent.MAX_ITERATIONS >= 10);
    assert.ok(agent.MAX_ITERATIONS <= 100);
  });

  it("MAX_SUBAGENT_ITERATIONS is less than MAX_ITERATIONS", () => {
    assert.ok(agent.MAX_SUBAGENT_ITERATIONS < agent.MAX_ITERATIONS);
  });

  it("MAX_CONTEXT_CHARS is reasonable", () => {
    assert.ok(agent.MAX_CONTEXT_CHARS >= 100000);
    assert.ok(agent.MAX_CONTEXT_CHARS <= 2000000);
  });

  it("MIN_KEEP_MESSAGES is at least 4", () => {
    assert.ok(agent.MIN_KEEP_MESSAGES >= 4);
  });

  it("MAX_TOOL_RESULT_CHARS is reasonable", () => {
    assert.ok(agent.MAX_TOOL_RESULT_CHARS >= 10000);
    assert.ok(agent.MAX_TOOL_RESULT_CHARS <= 1000000);
  });

  it("MAX_CONCURRENT_SUBAGENTS limits parallel execution", () => {
    assert.ok(agent.MAX_CONCURRENT_SUBAGENTS >= 1);
    assert.ok(agent.MAX_CONCURRENT_SUBAGENTS <= 10);
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    assert.equal(typeof agent.SYSTEM_PROMPT, "string");
    assert.ok(agent.SYSTEM_PROMPT.length > 100);
  });

  it("includes core capabilities", () => {
    assert.ok(agent.SYSTEM_PROMPT.includes("Web search"));
    assert.ok(agent.SYSTEM_PROMPT.includes("File storage"));
    assert.ok(agent.SYSTEM_PROMPT.includes("Code execution"));
    assert.ok(agent.SYSTEM_PROMPT.includes("Sub-agents"));
  });

  it("includes safety instructions", () => {
    assert.ok(agent.SYSTEM_PROMPT.includes("NEVER expose internal details"));
    assert.ok(agent.SYSTEM_PROMPT.includes("NEVER share local filesystem paths"));
    assert.ok(agent.SYSTEM_PROMPT.includes("SEND_FILE"));
  });
});

// ---------------------------------------------------------------------------
// executeWebFetch (SSRF)
// ---------------------------------------------------------------------------

describe("executeWebFetch", () => {
  it("is a function", () => {
    assert.equal(typeof agent.executeWebFetch, "function");
  });

  it("rejects invalid URLs", async () => {
    const result = await agent.executeWebFetch("not-a-url");
    assert.ok(result.includes("Error:"));
  });

  it("rejects empty URL", async () => {
    const result = await agent.executeWebFetch("");
    assert.ok(result.includes("Error:"));
  });

  it("rejects non-http protocols", async () => {
    const result = await agent.executeWebFetch("ftp://example.com");
    assert.ok(result.includes("Error:"));
  });

  it("rejects file:// protocol", async () => {
    const result = await agent.executeWebFetch("file:///etc/passwd");
    assert.ok(result.includes("Error:"));
  });

  it("rejects private IP addresses (SSRF prevention)", async () => {
    const result = await agent.executeWebFetch("http://127.0.0.1:8080");
    assert.ok(result.includes("Error:"));
  });

  it("rejects 10.x.x.x addresses (SSRF prevention)", async () => {
    const result = await agent.executeWebFetch("http://10.0.0.1");
    assert.ok(result.includes("Error:"));
  });

  it("rejects 169.254.169.254 (AWS metadata SSRF)", async () => {
    const result = await agent.executeWebFetch("http://169.254.169.254");
    assert.ok(result.includes("Error:"));
  });

  it("rejects 192.168.x.x addresses", async () => {
    const result = await agent.executeWebFetch("http://192.168.1.1");
    assert.ok(result.includes("Error:"));
  });

  it("rejects 172.16-31.x.x addresses", async () => {
    const result = await agent.executeWebFetch("http://172.16.0.1");
    assert.ok(result.includes("Error:"));
  });
});

// ---------------------------------------------------------------------------
// executeWebSearch
// ---------------------------------------------------------------------------

describe("executeWebSearch", () => {
  it("is a function", () => {
    assert.equal(typeof agent.executeWebSearch, "function");
  });

  it("rejects empty query", async () => {
    const result = await agent.executeWebSearch("");
    assert.ok(result.includes("Error:"));
  });

  it("rejects null query", async () => {
    const result = await agent.executeWebSearch(null);
    assert.ok(result.includes("Error:"));
  });
});

// ---------------------------------------------------------------------------
// chat function
// ---------------------------------------------------------------------------

describe("chat", () => {
  it("is a function", () => {
    assert.equal(typeof agent.chat, "function");
  });

  it("resets history properly", () => {
    agent.conversationHistory.push({ role: "test", content: "test" });
    agent.resetHistory();
    assert.equal(agent.conversationHistory.length, 0);
  });
});

// ---------------------------------------------------------------------------
// smartTruncate
// ---------------------------------------------------------------------------

describe("smartTruncate", () => {
  it("is a function", () => {
    assert.equal(typeof agent.smartTruncate, "function");
  });

  it("returns text unchanged when under limit", () => {
    const text = "short text";
    assert.equal(agent.smartTruncate(text, 1000), text);
  });

  it("returns text unchanged when exactly at limit", () => {
    const text = "x".repeat(100);
    assert.equal(agent.smartTruncate(text, 100), text);
  });

  it("truncates long text with head and tail", () => {
    const text = "HEAD_" + "x".repeat(1000) + "_TAIL";
    const result = agent.smartTruncate(text, 200);
    assert.ok(result.length <= 200, `result length ${result.length} exceeds limit 200`);
    assert.ok(result.startsWith("HEAD_"), "preserves head");
    assert.ok(result.endsWith("_TAIL"), "preserves tail");
    assert.ok(result.includes("TRUNCATED"), "includes truncation marker");
  });

  it("includes original length in truncation marker", () => {
    const text = "a".repeat(50000);
    const result = agent.smartTruncate(text, 1000);
    assert.ok(result.includes("50,000"), "shows original length formatted");
  });

  it("head portion is larger than tail (70/30 split)", () => {
    const text = "a".repeat(10000);
    const result = agent.smartTruncate(text, 1000);
    const markerIdx = result.indexOf("[...");
    const tailStart = result.lastIndexOf("...]") + 4;
    // Head should be ~70% of available space, tail ~30%
    assert.ok(markerIdx > tailStart - markerIdx, "head is larger than tail portion");
  });

  it("handles empty string", () => {
    assert.equal(agent.smartTruncate("", 100), "");
  });

  it("handles null/undefined", () => {
    assert.equal(agent.smartTruncate(null, 100), null);
    assert.equal(agent.smartTruncate(undefined, 100), undefined);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent efficiency constants
// ---------------------------------------------------------------------------

describe("sub-agent efficiency constants", () => {
  it("MAX_SUBAGENT_TOOL_RESULT_CHARS is exported and less than main agent limit", () => {
    assert.equal(typeof agent.MAX_SUBAGENT_TOOL_RESULT_CHARS, "number");
    assert.ok(agent.MAX_SUBAGENT_TOOL_RESULT_CHARS < agent.MAX_TOOL_RESULT_CHARS,
      "sub-agent limit should be stricter than main agent");
  });

  it("MAX_SUBAGENT_TOOL_RESULT_CHARS is reasonable (10K-50K range)", () => {
    assert.ok(agent.MAX_SUBAGENT_TOOL_RESULT_CHARS >= 10000, "at least 10KB");
    assert.ok(agent.MAX_SUBAGENT_TOOL_RESULT_CHARS <= 50000, "at most 50KB");
  });

  it("MAX_SUBAGENT_CONTEXT_CHARS is exported and less than main agent limit", () => {
    assert.equal(typeof agent.MAX_SUBAGENT_CONTEXT_CHARS, "number");
    assert.ok(agent.MAX_SUBAGENT_CONTEXT_CHARS < agent.MAX_CONTEXT_CHARS,
      "sub-agent context limit should be stricter than main agent");
  });

  it("MAX_SUBAGENT_CONTEXT_CHARS is reasonable (100K-400K range)", () => {
    assert.ok(agent.MAX_SUBAGENT_CONTEXT_CHARS >= 100000, "at least 100K");
    assert.ok(agent.MAX_SUBAGENT_CONTEXT_CHARS <= 400000, "at most 400K");
  });
});

// ---------------------------------------------------------------------------
// executeSpawnSubagents
// ---------------------------------------------------------------------------

describe("executeSpawnSubagents", () => {
  it("returns error for empty tasks", async () => {
    const result = await agent.executeSpawnSubagents({ tasks: [] }, "user1");
    assert.ok(result.includes("Error:"));
  });

  it("returns error for too many tasks", async () => {
    const tasks = [];
    for (let i = 0; i < agent.MAX_CONCURRENT_SUBAGENTS + 1; i++) {
      tasks.push({ description: `task ${i}` });
    }
    const result = await agent.executeSpawnSubagents({ tasks }, "user1");
    assert.ok(result.includes("Error:"));
    assert.ok(result.includes("Maximum"));
  });
});
