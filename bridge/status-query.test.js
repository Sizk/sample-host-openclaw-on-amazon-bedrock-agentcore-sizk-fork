/**
 * Tests for status query detection and status formatting logic.
 * These functions are defined in agentcore-contract.js but can't be imported
 * directly (it starts an HTTP server). We duplicate the logic here for testing.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// --- Duplicated from agentcore-contract.js for testing ---
// Keep in sync with the source! If you change isStatusQuery or formatSubagentStatus
// in agentcore-contract.js, update these copies too.

function isStatusQuery(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase().trim();
  const stripped = lower.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const patterns = [
    /^(como|cómo)\s+(va|vas|vamos)/,
    /^(que|qué)\s+tal\s+(va|vas)/,
    /^(how('s| is|s)?\s+(it|that|the task)?\s*(going|progressing|doing))/,
    /^status\b/,
    /^progress\b/,
    /^(sigues|estas|estás)\s+(ahí|ahi|trabajando)/,
    /^(still|are you)\s+(there|working|running)/,
    /^(en que|en qué)\s+(andas|vas|estas|estás)/,
    /^(what'?s?\s+happening|what are you doing)/,
    /^(como|cómo)\s+va\s+(el|la|eso)/,
    /^(que|qué)\s+(haces|estas haciendo|estás haciendo)/,
  ];
  return /^\?+$/.test(lower) || patterns.some((p) => p.test(stripped));
}

function formatSubagentStatus(status) {
  if (!status) return null;
  const elapsed = status.elapsedSeconds;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const total = status.agents.length;
  const completed = status.agents.filter((a) => a.status === "completed").length;

  const taskSummaries = status.agents.map((a) => {
    const emoji = a.status === "completed" ? "\u2705" : a.status === "running" ? "\u23f3" : "\u2699\ufe0f";
    const desc = (a.description || "Processing").replace(/https?:\/\/\S+/g, "").trim() || "Processing";
    return `${emoji} ${desc}`;
  });

  let msg = `Working on it (${timeStr} elapsed).`;
  if (total > 1) {
    msg += ` ${completed}/${total} tasks done.`;
  }
  msg += `\n\n${taskSummaries.join("\n")}`;

  return msg;
}

// ---------------------------------------------------------------------------
// isStatusQuery tests
// ---------------------------------------------------------------------------

describe("isStatusQuery", () => {
  // Basic matches
  it("matches single question mark", () => assert.ok(isStatusQuery("?")));
  it("matches multiple question marks", () => assert.ok(isStatusQuery("???")));
  it("matches 'como vas'", () => assert.ok(isStatusQuery("como vas")));
  it("matches 'como vas?'", () => assert.ok(isStatusQuery("como vas?")));
  it("matches 'COMO VAS?'", () => assert.ok(isStatusQuery("COMO VAS?")));
  it("matches 'how is it going'", () => assert.ok(isStatusQuery("how is it going")));
  it("matches 'status'", () => assert.ok(isStatusQuery("status")));
  it("matches 'status?'", () => assert.ok(isStatusQuery("status?")));
  it("matches 'que tal vas'", () => assert.ok(isStatusQuery("que tal vas")));
  it("matches 'sigues ahi'", () => assert.ok(isStatusQuery("sigues ahi")));
  it("matches 'still working'", () => assert.ok(isStatusQuery("still working")));
  it("matches 'what are you doing'", () => assert.ok(isStatusQuery("what are you doing")));

  // THE CRITICAL FIX — leading punctuation before status query
  it("matches '?? como vas?'", () => assert.ok(isStatusQuery("?? como vas?")));
  it("matches '!! como vas'", () => assert.ok(isStatusQuery("!! como vas")));
  it("matches '... how is it going'", () => assert.ok(isStatusQuery("... how is it going")));
  it("matches '?como vas?'", () => assert.ok(isStatusQuery("?como vas?")));

  // Non-matches — real messages that should NOT be detected as status queries
  it("does not match regular messages", () => assert.ok(!isStatusQuery("busca pisos en valencia")));
  it("does not match greetings", () => assert.ok(!isStatusQuery("hola")));
  it("does not match questions about other things", () => assert.ok(!isStatusQuery("como se llama la capital de francia")));
  it("does not match empty string", () => assert.ok(!isStatusQuery("")));
  it("does not match null", () => assert.ok(!isStatusQuery(null)));
});

// ---------------------------------------------------------------------------
// formatSubagentStatus tests
// ---------------------------------------------------------------------------

describe("formatSubagentStatus", () => {
  it("returns null for null status", () => {
    assert.equal(formatSubagentStatus(null), null);
  });

  it("shows elapsed time", () => {
    const status = {
      elapsedSeconds: 125,
      agents: [{ id: 1, status: "running", description: "Searching for apartments" }],
    };
    const result = formatSubagentStatus(status);
    assert.ok(result.includes("2m 5s"), "shows minutes and seconds");
  });

  it("shows task count for multi-agent", () => {
    const status = {
      elapsedSeconds: 60,
      agents: [
        { id: 1, status: "completed", description: "Task A" },
        { id: 2, status: "running", description: "Task B" },
        { id: 3, status: "running", description: "Task C" },
      ],
    };
    const result = formatSubagentStatus(status);
    assert.ok(result.includes("1/3 tasks done"), "shows completion count");
  });

  it("NEVER exposes tool names", () => {
    const status = {
      elapsedSeconds: 30,
      agents: [{
        id: 1, status: "running", toolSet: "web_scraping",
        description: "Scrape fotocasa listings",
        lastTool: "exec", lastToolArg: "node /tmp/scraper.js",
      }],
    };
    const result = formatSubagentStatus(status);
    assert.ok(!result.includes("web_scraping"), "no tool set name");
    assert.ok(!result.includes("exec"), "no tool name");
    assert.ok(!result.includes("/tmp/"), "no file paths");
    assert.ok(!result.includes("node "), "no commands");
  });

  it("NEVER exposes URLs", () => {
    const status = {
      elapsedSeconds: 30,
      agents: [{
        id: 1, status: "running",
        description: "Scrape https://fotocasa.es/listings for apartments",
        lastTool: "web_fetch", lastToolArg: "https://fotocasa.es/search",
      }],
    };
    const result = formatSubagentStatus(status);
    assert.ok(!result.includes("https://"), "no URLs in output");
    assert.ok(!result.includes("http://"), "no HTTP URLs");
  });

  it("NEVER exposes step counts or iteration numbers", () => {
    const status = {
      elapsedSeconds: 30,
      agents: [{
        id: 1, status: "running", iteration: 7, maxIterations: 15,
        description: "Research task",
      }],
    };
    const result = formatSubagentStatus(status);
    assert.ok(!result.includes("7/15"), "no iteration count");
    assert.ok(!result.includes("step"), "no step label");
  });

  it("shows clean task descriptions", () => {
    const status = {
      elapsedSeconds: 45,
      agents: [
        { id: 1, status: "running", description: "Search for land plots in Bizkaia" },
        { id: 2, status: "completed", description: "Compare prices across portals" },
      ],
    };
    const result = formatSubagentStatus(status);
    assert.ok(result.includes("Search for land plots in Bizkaia"), "shows task description");
    assert.ok(result.includes("Compare prices across portals"), "shows second task");
  });

  it("uses appropriate status emojis", () => {
    const status = {
      elapsedSeconds: 10,
      agents: [
        { id: 1, status: "completed", description: "Done task" },
        { id: 2, status: "running", description: "Active task" },
        { id: 3, status: "starting", description: "Starting task" },
      ],
    };
    const result = formatSubagentStatus(status);
    assert.ok(result.includes("\u2705"), "completed gets checkmark");
    assert.ok(result.includes("\u23f3"), "running gets hourglass");
  });
});
