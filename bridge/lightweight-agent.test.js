/**
 * Tests for lightweight-agent.js — tool definitions, buildToolArgs, and web tools.
 *
 * Covers: TOOLS definitions, SCRIPT_MAP, TOOL_ENV, buildToolArgs logic,
 *         web_fetch and web_search in-process tools, stripHtml, parseSearchResults.
 * Run: cd bridge && node --test lightweight-agent.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { TOOLS, SCRIPT_MAP, TOOL_ENV, buildToolArgs, stripHtml, parseSearchResults, executeWebFetch, executeWebSearch } = require("./lightweight-agent");

// --- TOOLS array ---

describe("TOOLS", () => {
  const EXPECTED_TOOLS = [
    "read_user_file",
    "write_user_file",
    "list_user_files",
    "delete_user_file",
    "create_schedule",
    "list_schedules",
    "update_schedule",
    "delete_schedule",
    "web_fetch",
    "web_search",
  ];

  it("contains all 10 expected tools", () => {
    const names = TOOLS.map((t) => t.function.name);
    assert.deepStrictEqual(names, EXPECTED_TOOLS);
  });

  it("every tool has valid OpenAI function-calling schema", () => {
    for (const tool of TOOLS) {
      assert.equal(tool.type, "function", `${tool.function?.name} type`);
      assert.ok(tool.function.name, "function.name required");
      assert.ok(tool.function.description, "function.description required");
      assert.equal(
        tool.function.parameters.type,
        "object",
        `${tool.function.name} parameters.type`,
      );
      assert.ok(
        Array.isArray(tool.function.parameters.required),
        `${tool.function.name} required array`,
      );
    }
  });

  it("create_schedule requires cron_expression, timezone, message", () => {
    const tool = TOOLS.find((t) => t.function.name === "create_schedule");
    assert.deepStrictEqual(tool.function.parameters.required, [
      "cron_expression",
      "timezone",
      "message",
    ]);
    const props = Object.keys(tool.function.parameters.properties);
    assert.ok(props.includes("cron_expression"));
    assert.ok(props.includes("timezone"));
    assert.ok(props.includes("message"));
    assert.ok(props.includes("schedule_name"));
  });

  it("list_schedules has no required params", () => {
    const tool = TOOLS.find((t) => t.function.name === "list_schedules");
    assert.deepStrictEqual(tool.function.parameters.required, []);
  });

  it("update_schedule requires schedule_id only", () => {
    const tool = TOOLS.find((t) => t.function.name === "update_schedule");
    assert.deepStrictEqual(tool.function.parameters.required, ["schedule_id"]);
    const props = Object.keys(tool.function.parameters.properties);
    assert.ok(props.includes("schedule_id"));
    assert.ok(props.includes("expression"));
    assert.ok(props.includes("timezone"));
    assert.ok(props.includes("message"));
    assert.ok(props.includes("name"));
    assert.ok(props.includes("enable"));
    assert.ok(props.includes("disable"));
  });

  it("delete_schedule requires schedule_id", () => {
    const tool = TOOLS.find((t) => t.function.name === "delete_schedule");
    assert.deepStrictEqual(tool.function.parameters.required, ["schedule_id"]);
  });

  it("web_fetch requires url", () => {
    const tool = TOOLS.find((t) => t.function.name === "web_fetch");
    assert.ok(tool, "web_fetch tool should exist");
    assert.deepStrictEqual(tool.function.parameters.required, ["url"]);
    assert.ok(tool.function.parameters.properties.url);
  });

  it("web_search requires query", () => {
    const tool = TOOLS.find((t) => t.function.name === "web_search");
    assert.ok(tool, "web_search tool should exist");
    assert.deepStrictEqual(tool.function.parameters.required, ["query"]);
    assert.ok(tool.function.parameters.properties.query);
  });
});

// --- SCRIPT_MAP ---

describe("SCRIPT_MAP", () => {
  it("has an entry for every tool in TOOLS", () => {
    for (const tool of TOOLS) {
      const name = tool.function.name;
      assert.ok(name in SCRIPT_MAP, `SCRIPT_MAP missing entry for ${name}`);
    }
  });

  it("cron scripts point to /skills/eventbridge-cron/", () => {
    assert.equal(SCRIPT_MAP.create_schedule, "/skills/eventbridge-cron/create.js");
    assert.equal(SCRIPT_MAP.list_schedules, "/skills/eventbridge-cron/list.js");
    assert.equal(SCRIPT_MAP.update_schedule, "/skills/eventbridge-cron/update.js");
    assert.equal(SCRIPT_MAP.delete_schedule, "/skills/eventbridge-cron/delete.js");
  });

  it("s3 scripts point to /skills/s3-user-files/", () => {
    assert.equal(SCRIPT_MAP.read_user_file, "/skills/s3-user-files/read.js");
    assert.equal(SCRIPT_MAP.write_user_file, "/skills/s3-user-files/write.js");
    assert.equal(SCRIPT_MAP.list_user_files, "/skills/s3-user-files/list.js");
    assert.equal(SCRIPT_MAP.delete_user_file, "/skills/s3-user-files/delete.js");
  });

  it("web tools are marked as in-process (no script path)", () => {
    assert.equal(SCRIPT_MAP.web_fetch, null);
    assert.equal(SCRIPT_MAP.web_search, null);
  });
});

// --- TOOL_ENV ---

describe("TOOL_ENV", () => {
  it("includes base env vars", () => {
    assert.ok("PATH" in TOOL_ENV);
    assert.ok("HOME" in TOOL_ENV);
    assert.ok("NODE_PATH" in TOOL_ENV);
    assert.ok("NODE_OPTIONS" in TOOL_ENV);
    assert.ok("AWS_REGION" in TOOL_ENV);
    assert.ok("S3_USER_FILES_BUCKET" in TOOL_ENV);
  });

  it("includes cron env vars", () => {
    assert.ok("EVENTBRIDGE_SCHEDULE_GROUP" in TOOL_ENV);
    assert.ok("CRON_LAMBDA_ARN" in TOOL_ENV);
    assert.ok("EVENTBRIDGE_ROLE_ARN" in TOOL_ENV);
    assert.ok("IDENTITY_TABLE_NAME" in TOOL_ENV);
  });

  it("defaults cron env vars to empty string when not set", () => {
    // In test environment, these env vars are not set
    // TOOL_ENV should default them to "" rather than undefined
    assert.equal(typeof TOOL_ENV.EVENTBRIDGE_SCHEDULE_GROUP, "string");
    assert.equal(typeof TOOL_ENV.CRON_LAMBDA_ARN, "string");
    assert.equal(typeof TOOL_ENV.EVENTBRIDGE_ROLE_ARN, "string");
    assert.equal(typeof TOOL_ENV.IDENTITY_TABLE_NAME, "string");
  });
});

// --- buildToolArgs ---

describe("buildToolArgs", () => {
  const USER_ID = "telegram_12345";

  it("returns null for unknown tool", () => {
    assert.equal(buildToolArgs("nonexistent_tool", {}, USER_ID), null);
  });

  // --- s3-user-files (existing, verify no regression) ---

  it("read_user_file: script, userId, filename", () => {
    const result = buildToolArgs("read_user_file", { filename: "notes.md" }, USER_ID);
    assert.deepStrictEqual(result, [
      "/skills/s3-user-files/read.js",
      USER_ID,
      "notes.md",
    ]);
  });

  it("read_user_file: defaults filename to empty string", () => {
    const result = buildToolArgs("read_user_file", {}, USER_ID);
    assert.equal(result[2], "");
  });

  it("list_user_files: script, userId only", () => {
    const result = buildToolArgs("list_user_files", {}, USER_ID);
    assert.deepStrictEqual(result, ["/skills/s3-user-files/list.js", USER_ID]);
  });

  it("delete_user_file: script, userId, filename", () => {
    const result = buildToolArgs("delete_user_file", { filename: "old.txt" }, USER_ID);
    assert.deepStrictEqual(result, [
      "/skills/s3-user-files/delete.js",
      USER_ID,
      "old.txt",
    ]);
  });

  // --- create_schedule ---

  it("create_schedule: positional args (expression, timezone, message)", () => {
    const result = buildToolArgs(
      "create_schedule",
      {
        cron_expression: "cron(0 9 * * ? *)",
        timezone: "Asia/Shanghai",
        message: "Check email",
      },
      USER_ID,
    );
    assert.deepStrictEqual(result, [
      "/skills/eventbridge-cron/create.js",
      USER_ID,
      "cron(0 9 * * ? *)",
      "Asia/Shanghai",
      "Check email",
    ]);
  });

  it("create_schedule: includes schedule_name with channel placeholders", () => {
    const result = buildToolArgs(
      "create_schedule",
      {
        cron_expression: "cron(0 17 ? * MON-FRI *)",
        timezone: "America/New_York",
        message: "Log hours",
        schedule_name: "Work reminder",
      },
      USER_ID,
    );
    assert.deepStrictEqual(result, [
      "/skills/eventbridge-cron/create.js",
      USER_ID,
      "cron(0 17 ? * MON-FRI *)",
      "America/New_York",
      "Log hours",
      "", // channel placeholder
      "", // channelTarget placeholder
      "Work reminder",
    ]);
  });

  it("create_schedule: omits placeholders when no schedule_name", () => {
    const result = buildToolArgs(
      "create_schedule",
      {
        cron_expression: "rate(1 hour)",
        timezone: "UTC",
        message: "Ping",
      },
      USER_ID,
    );
    // Should be exactly 5 elements — no placeholders
    assert.equal(result.length, 5);
  });

  it("create_schedule: defaults missing required args to empty string", () => {
    const result = buildToolArgs("create_schedule", {}, USER_ID);
    assert.equal(result[2], ""); // cron_expression
    assert.equal(result[3], ""); // timezone
    assert.equal(result[4], ""); // message
  });

  // --- list_schedules ---

  it("list_schedules: script, userId only", () => {
    const result = buildToolArgs("list_schedules", {}, USER_ID);
    assert.deepStrictEqual(result, ["/skills/eventbridge-cron/list.js", USER_ID]);
  });

  // --- update_schedule ---

  it("update_schedule: minimal (schedule_id only)", () => {
    const result = buildToolArgs(
      "update_schedule",
      { schedule_id: "a1b2c3d4" },
      USER_ID,
    );
    assert.deepStrictEqual(result, [
      "/skills/eventbridge-cron/update.js",
      USER_ID,
      "a1b2c3d4",
    ]);
  });

  it("update_schedule: all optional flags", () => {
    const result = buildToolArgs(
      "update_schedule",
      {
        schedule_id: "a1b2c3d4",
        expression: "cron(30 8 * * ? *)",
        timezone: "Europe/London",
        message: "New message",
        name: "Morning alert",
      },
      USER_ID,
    );
    assert.deepStrictEqual(result, [
      "/skills/eventbridge-cron/update.js",
      USER_ID,
      "a1b2c3d4",
      "--expression",
      "cron(30 8 * * ? *)",
      "--timezone",
      "Europe/London",
      "--message",
      "New message",
      "--name",
      "Morning alert",
    ]);
  });

  it("update_schedule: --enable flag", () => {
    const result = buildToolArgs(
      "update_schedule",
      { schedule_id: "abc", enable: true },
      USER_ID,
    );
    assert.ok(result.includes("--enable"));
    assert.ok(!result.includes("--disable"));
  });

  it("update_schedule: --disable flag", () => {
    const result = buildToolArgs(
      "update_schedule",
      { schedule_id: "abc", disable: true },
      USER_ID,
    );
    assert.ok(result.includes("--disable"));
    assert.ok(!result.includes("--enable"));
  });

  it("update_schedule: enable+disable conflict — neither flag passed", () => {
    const result = buildToolArgs(
      "update_schedule",
      { schedule_id: "abc", enable: true, disable: true },
      USER_ID,
    );
    assert.ok(!result.includes("--enable"), "should not include --enable");
    assert.ok(!result.includes("--disable"), "should not include --disable");
  });

  it("update_schedule: enable=false does not push --enable", () => {
    const result = buildToolArgs(
      "update_schedule",
      { schedule_id: "abc", enable: false },
      USER_ID,
    );
    assert.ok(!result.includes("--enable"));
    assert.ok(!result.includes("--disable"));
  });

  it("update_schedule: defaults missing schedule_id to empty string", () => {
    const result = buildToolArgs("update_schedule", {}, USER_ID);
    assert.equal(result[2], "");
  });

  // --- delete_schedule ---

  it("delete_schedule: script, userId, schedule_id", () => {
    const result = buildToolArgs(
      "delete_schedule",
      { schedule_id: "deadbeef" },
      USER_ID,
    );
    assert.deepStrictEqual(result, [
      "/skills/eventbridge-cron/delete.js",
      USER_ID,
      "deadbeef",
    ]);
  });

  it("delete_schedule: defaults missing schedule_id to empty string", () => {
    const result = buildToolArgs("delete_schedule", {}, USER_ID);
    assert.equal(result[2], "");
  });
});

// --- Argument position alignment with actual scripts ---

describe("CLI arg alignment with script argv positions", () => {
  // These tests verify the argument positions match what each script expects.
  // create.js: argv[2]=userId, argv[3]=expression, argv[4]=timezone,
  //            argv[5]=message, argv[6]=channel, argv[7]=channelTarget,
  //            argv[8+]=scheduleName

  it("create_schedule args align with create.js argv expectations", () => {
    const args = buildToolArgs(
      "create_schedule",
      {
        cron_expression: "cron(0 9 * * ? *)",
        timezone: "UTC",
        message: "Test",
        schedule_name: "My Schedule",
      },
      "telegram_999",
    );
    // args[0] = script path (becomes argv[1] when prefixed with "node")
    // In execFile("node", args), argv = [node, args[0], args[1], ...]
    // So: argv[2] = args[1] = userId
    assert.equal(args[1], "telegram_999"); // argv[2]
    assert.equal(args[2], "cron(0 9 * * ? *)"); // argv[3]
    assert.equal(args[3], "UTC"); // argv[4]
    assert.equal(args[4], "Test"); // argv[5]
    assert.equal(args[5], ""); // argv[6] - channel placeholder
    assert.equal(args[6], ""); // argv[7] - channelTarget placeholder
    assert.equal(args[7], "My Schedule"); // argv[8] - scheduleName
  });

  // update.js: argv[2]=userId, argv[3]=scheduleId, argv[4+]=flags
  it("update_schedule args align with update.js parseArgs expectations", () => {
    const args = buildToolArgs(
      "update_schedule",
      {
        schedule_id: "abc12345",
        expression: "cron(0 10 * * ? *)",
        message: "Updated msg",
      },
      "slack_U123",
    );
    assert.equal(args[1], "slack_U123"); // argv[2]
    assert.equal(args[2], "abc12345"); // argv[3]
    // Flags start at argv[4+], which is args[3+]
    assert.equal(args[3], "--expression");
    assert.equal(args[4], "cron(0 10 * * ? *)");
    assert.equal(args[5], "--message");
    assert.equal(args[6], "Updated msg");
  });

  // list.js: argv[2]=userId
  it("list_schedules args align with list.js argv expectations", () => {
    const args = buildToolArgs("list_schedules", {}, "telegram_999");
    assert.equal(args.length, 2); // [script, userId]
    assert.equal(args[1], "telegram_999"); // argv[2]
  });

  // delete.js: argv[2]=userId, argv[3]=scheduleId
  it("delete_schedule args align with delete.js argv expectations", () => {
    const args = buildToolArgs("delete_schedule", { schedule_id: "ff00ff00" }, "telegram_999");
    assert.equal(args[1], "telegram_999"); // argv[2]
    assert.equal(args[2], "ff00ff00"); // argv[3]
  });
});

// --- stripHtml ---

describe("stripHtml", () => {
  it("removes simple HTML tags", () => {
    assert.equal(stripHtml("<p>Hello</p>"), "Hello");
  });

  it("removes nested tags", () => {
    assert.equal(stripHtml("<div><p><b>Bold</b> text</p></div>"), "Bold text");
  });

  it("handles script and style tags by removing content", () => {
    const html = '<p>Before</p><script>alert("xss")</script><p>After</p>';
    const result = stripHtml(html);
    assert.ok(!result.includes("alert"), "should remove script content");
    assert.ok(result.includes("Before"));
    assert.ok(result.includes("After"));
  });

  it("handles style tags by removing content", () => {
    const html = "<p>Text</p><style>body { color: red; }</style><p>More</p>";
    const result = stripHtml(html);
    assert.ok(!result.includes("color"), "should remove style content");
    assert.ok(result.includes("Text"));
    assert.ok(result.includes("More"));
  });

  it("handles noscript tags by removing content", () => {
    const html = "<p>Main</p><noscript><p>Enable JS</p></noscript><p>End</p>";
    const result = stripHtml(html);
    assert.ok(!result.includes("Enable JS"), "should remove noscript content");
    assert.ok(result.includes("Main"));
    assert.ok(result.includes("End"));
  });

  it("removes HTML comments", () => {
    const html = "<p>Visible</p><!-- secret comment --><p>Also visible</p>";
    const result = stripHtml(html);
    assert.ok(!result.includes("secret"), "should remove comment content");
    assert.ok(result.includes("Visible"));
    assert.ok(result.includes("Also visible"));
  });

  it("decodes common HTML entities", () => {
    assert.ok(stripHtml("&amp;").includes("&"));
    assert.ok(stripHtml("&lt;").includes("<"));
    assert.ok(stripHtml("&gt;").includes(">"));
    assert.ok(stripHtml("&quot;").includes('"'));
    assert.ok(stripHtml("&#39;").includes("'"));
    // &nbsp; decodes to space — verify in context (standalone trims away)
    assert.ok(stripHtml("hello&nbsp;world").includes("hello world"));
  });

  it("collapses multiple whitespace into single spaces", () => {
    const result = stripHtml("<p>Hello</p>   \n\n   <p>World</p>");
    // Should not have excessive whitespace
    assert.ok(!result.includes("   "), "should collapse whitespace");
  });

  it("returns empty string for empty input", () => {
    assert.equal(stripHtml(""), "");
  });

  it("returns plain text unchanged", () => {
    assert.equal(stripHtml("No HTML here"), "No HTML here");
  });
});

// --- parseSearchResults ---

describe("parseSearchResults", () => {
  it("extracts results from DuckDuckGo-style HTML", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://example.com">Example Title</a>
        <a class="result__snippet">This is the snippet text</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://other.com">Other Page</a>
        <a class="result__snippet">Another snippet</a>
      </div>
    `;
    const result = parseSearchResults(html);
    assert.ok(result.includes("Example Title"), "should include first title");
    assert.ok(result.includes("https://example.com"), "should include first URL");
    assert.ok(result.includes("Other Page"), "should include second title");
  });

  it("returns 'no results' message for empty HTML", () => {
    const result = parseSearchResults("");
    assert.ok(result.toLowerCase().includes("no") || result.length === 0 || result.includes("No results"));
  });

  it("returns 'no results' message for HTML with no search results", () => {
    const result = parseSearchResults("<html><body><p>Nothing here</p></body></html>");
    assert.ok(result.includes("No results") || result.includes("no results") || result.trim().length === 0);
  });

  it("extracts actual URLs from DuckDuckGo redirect wrappers", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="/l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2Fpage">Example</a>
        <a class="result__snippet">A snippet</a>
      </div>
    `;
    const result = parseSearchResults(html);
    assert.ok(result.includes("https://example.com/page"), "should decode uddg URL");
    assert.ok(!result.includes("uddg"), "should not include redirect params");
  });

  it("limits results to reasonable count", () => {
    // Build HTML with many results
    let html = "";
    for (let i = 0; i < 20; i++) {
      html += `<div class="result"><a class="result__a" href="https://example${i}.com">Title ${i}</a><a class="result__snippet">Snippet ${i}</a></div>`;
    }
    const result = parseSearchResults(html);
    // Should not return all 20 — should cap at a reasonable number
    const urlCount = (result.match(/https:\/\/example/g) || []).length;
    assert.ok(urlCount <= 10, `should limit results, got ${urlCount}`);
  });
});

// --- buildToolArgs for web tools ---

describe("buildToolArgs for web tools", () => {
  const USER_ID = "telegram_12345";

  it("web_fetch returns null (in-process, not a script tool)", () => {
    const result = buildToolArgs("web_fetch", { url: "https://example.com" }, USER_ID);
    assert.equal(result, null);
  });

  it("web_search returns null (in-process, not a script tool)", () => {
    const result = buildToolArgs("web_search", { query: "test query" }, USER_ID);
    assert.equal(result, null);
  });
});

// --- executeWebFetch ---

describe("executeWebFetch", () => {
  it("is a function", () => {
    assert.equal(typeof executeWebFetch, "function");
  });

  it("rejects invalid URLs", async () => {
    const result = await executeWebFetch("not-a-url");
    assert.ok(result.startsWith("Error:"), `should return error, got: ${result}`);
  });

  it("rejects empty URL", async () => {
    const result = await executeWebFetch("");
    assert.ok(result.startsWith("Error:"), `should return error, got: ${result}`);
  });

  it("rejects non-http protocols", async () => {
    const result = await executeWebFetch("ftp://example.com");
    assert.ok(result.startsWith("Error:"), `should reject ftp, got: ${result}`);
  });

  it("rejects file:// protocol", async () => {
    const result = await executeWebFetch("file:///etc/passwd");
    assert.ok(result.startsWith("Error:"), `should reject file://, got: ${result}`);
  });

  it("rejects private IP addresses (SSRF prevention)", async () => {
    const result = await executeWebFetch("http://127.0.0.1/secret");
    assert.ok(result.startsWith("Error:"), `should reject localhost, got: ${result}`);
  });

  it("rejects 10.x.x.x addresses (SSRF prevention)", async () => {
    const result = await executeWebFetch("http://10.0.0.1/metadata");
    assert.ok(result.startsWith("Error:"), `should reject private IP, got: ${result}`);
  });

  it("rejects 169.254.169.254 (AWS metadata SSRF)", async () => {
    const result = await executeWebFetch("http://169.254.169.254/latest/meta-data/");
    assert.ok(result.startsWith("Error:"), `should reject metadata endpoint, got: ${result}`);
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    const result = await executeWebFetch("http://[::ffff:127.0.0.1]/secret");
    assert.ok(result.startsWith("Error:"), `should reject IPv4-mapped loopback, got: ${result}`);
  });

  it("rejects IPv4-mapped IPv6 private (::ffff:10.0.0.1)", async () => {
    const result = await executeWebFetch("http://[::ffff:10.0.0.1]/internal");
    assert.ok(result.startsWith("Error:"), `should reject IPv4-mapped private, got: ${result}`);
  });

  it("rejects IPv4-mapped IPv6 metadata (::ffff:169.254.169.254)", async () => {
    const result = await executeWebFetch("http://[::ffff:169.254.169.254]/meta-data/");
    assert.ok(result.startsWith("Error:"), `should reject IPv4-mapped IMDS, got: ${result}`);
  });

  it("rejects 192.168.x.x addresses", async () => {
    const result = await executeWebFetch("http://192.168.1.1/admin");
    assert.ok(result.startsWith("Error:"), `should reject 192.168, got: ${result}`);
  });

  it("rejects 172.16-31.x.x addresses", async () => {
    const result = await executeWebFetch("http://172.16.0.1/internal");
    assert.ok(result.startsWith("Error:"), `should reject 172.16, got: ${result}`);
  });
});

// --- executeWebSearch ---

describe("executeWebSearch", () => {
  it("is a function", () => {
    assert.equal(typeof executeWebSearch, "function");
  });

  it("rejects empty query", async () => {
    const result = await executeWebSearch("");
    assert.ok(result.startsWith("Error:") || result.includes("No results"), `should handle empty query, got: ${result}`);
  });
});
