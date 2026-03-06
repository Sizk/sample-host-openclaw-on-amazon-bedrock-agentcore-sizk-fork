/**
 * Tests for extractTextFromContent from agentcore-contract.js.
 * Run: node --test content-extraction.test.js
 *
 * Since extractTextFromContent is not exported (inline in the contract server),
 * we mirror the logic here — same pattern as subagent-routing.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// --- Mirror of extractTextFromContent from agentcore-contract.js ---
// Includes sanitization + regex fallback (must stay in sync with contract server)

function extractTextFromContent(content) {
  if (!content) return "";
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return extractTextFromContent(text);
  }
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("[{") && trimmed.endsWith("]")) {
      // Sanitize control characters (literal newlines, tabs)
      const sanitized = trimmed.replace(/[\x00-\x1f]/g, (ch) => {
        if (ch === "\n") return "\\n";
        if (ch === "\r") return "\\r";
        if (ch === "\t") return "\\t";
        return "";
      });
      try {
        const parsed = JSON.parse(sanitized);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed[0].type === "text"
        ) {
          const text = parsed
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
          return extractTextFromContent(text);
        }
      } catch {}
      // Regex fallback: strip [{"type":"text","text":"..."}] wrapper
      const prefixMatch = trimmed.match(
        /^\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"/,
      );
      if (prefixMatch && trimmed.endsWith('"}]')) {
        const inner = trimmed.slice(prefixMatch[0].length, -3);
        const unescaped = inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        return extractTextFromContent(unescaped);
      }
    }
    return content;
  }
  if (typeof content === "object" && content !== null) {
    if (typeof content.text === "string")
      return extractTextFromContent(content.text);
    if (typeof content.content === "string")
      return extractTextFromContent(content.content);
    if (Array.isArray(content.content)) {
      const text = content.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return extractTextFromContent(text);
    }
  }
  return "";
}

// --- Tests ---

describe("extractTextFromContent", () => {
  it("returns empty string for falsy input", () => {
    assert.equal(extractTextFromContent(null), "");
    assert.equal(extractTextFromContent(undefined), "");
    assert.equal(extractTextFromContent(""), "");
    assert.equal(extractTextFromContent(0), "");
  });

  it("returns plain text string as-is", () => {
    assert.equal(extractTextFromContent("Hello world"), "Hello world");
  });

  it("extracts text from a parsed content blocks array", () => {
    const blocks = [{ type: "text", text: "Hello " }, { type: "text", text: "world" }];
    assert.equal(extractTextFromContent(blocks), "Hello world");
  });

  it("extracts text from a JSON-serialized content blocks string", () => {
    const json = JSON.stringify([{ type: "text", text: "Hello world" }]);
    assert.equal(extractTextFromContent(json), "Hello world");
  });

  it("extracts text from object with text property", () => {
    assert.equal(extractTextFromContent({ text: "Hello" }), "Hello");
  });

  it("extracts text from object with content string property", () => {
    assert.equal(extractTextFromContent({ content: "Hello" }), "Hello");
  });

  it("extracts text from object with content array property", () => {
    const obj = { content: [{ type: "text", text: "Hello" }] };
    assert.equal(extractTextFromContent(obj), "Hello");
  });

  // --- Nested content blocks (subagent scenarios) ---

  it("unwraps double-nested content blocks (subagent response)", () => {
    const inner = JSON.stringify([{ type: "text", text: "Found several skills." }]);
    const outer = JSON.stringify([{ type: "text", text: inner }]);
    assert.equal(extractTextFromContent(outer), "Found several skills.");
  });

  it("unwraps triple-nested content blocks (deep subagent chain)", () => {
    const level1 = "Found several. Here are the most relevant.";
    const level2 = JSON.stringify([{ type: "text", text: level1 }]);
    const level3 = JSON.stringify([{ type: "text", text: level2 }]);
    const level4 = JSON.stringify([{ type: "text", text: level3 }]);
    assert.equal(extractTextFromContent(level4), level1);
  });

  it("unwraps nested content blocks from parsed array", () => {
    const inner = JSON.stringify([{ type: "text", text: "Actual response" }]);
    const blocks = [{ type: "text", text: inner }];
    assert.equal(extractTextFromContent(blocks), "Actual response");
  });

  it("unwraps nested content blocks from object with content property", () => {
    const inner = JSON.stringify([{ type: "text", text: "Deep text" }]);
    const obj = { content: [{ type: "text", text: inner }] };
    assert.equal(extractTextFromContent(obj), "Deep text");
  });

  it("handles text that looks like JSON but is not content blocks", () => {
    const text = '[{"key": "value"}]';
    assert.equal(extractTextFromContent(text), text);
  });

  it("handles malformed JSON gracefully", () => {
    const text = '[{"type":"text","text":"broken';
    assert.equal(extractTextFromContent(text), text);
  });

  it("preserves newlines and markdown in unwrapped text", () => {
    const inner = "# Title\n\n- Item 1\n- Item 2\n\n**Bold** text";
    const wrapped = JSON.stringify([{ type: "text", text: inner }]);
    assert.equal(extractTextFromContent(wrapped), inner);
  });

  it("concatenates multiple text blocks before unwrapping", () => {
    const blocks = [
      { type: "text", text: "Part 1. " },
      { type: "text", text: "Part 2." },
    ];
    assert.equal(extractTextFromContent(blocks), "Part 1. Part 2.");
  });

  it("filters out non-text blocks", () => {
    const blocks = [
      { type: "text", text: "Hello" },
      { type: "image", data: "..." },
      { type: "text", text: " world" },
    ];
    assert.equal(extractTextFromContent(blocks), "Hello world");
  });

  // --- Sanitization: literal newlines in JSON strings ---

  it("handles content blocks with literal newlines in JSON", () => {
    // Build a string with actual newline bytes inside the JSON string value
    const raw = '[{"type":"text","text":"Hello\nWorld"}]';
    assert.equal(extractTextFromContent(raw), "Hello\nWorld");
  });

  it("handles content blocks with literal tabs in JSON", () => {
    const raw = '[{"type":"text","text":"Col1\tCol2"}]';
    assert.equal(extractTextFromContent(raw), "Col1\tCol2");
  });

  // --- Regex fallback: when JSON.parse fails ---

  it("unwraps via regex when JSON has unmatched escaping", () => {
    // Simulate content that JSON.parse might choke on but regex can handle
    const raw = '[{"type":"text","text":"Hello \\n World"}]';
    assert.equal(extractTextFromContent(raw), "Hello \n World");
  });

  it("handles escaped quotes via regex fallback", () => {
    const raw = '[{"type":"text","text":"He said \\"hello\\""}]';
    const result = extractTextFromContent(raw);
    assert.equal(result, 'He said "hello"');
  });

  it("handles escaped backslashes via regex fallback", () => {
    const raw = '[{"type":"text","text":"path\\\\to\\\\file"}]';
    const result = extractTextFromContent(raw);
    assert.equal(result, "path\\to\\file");
  });

  it("handles emojis in content blocks", () => {
    const json = JSON.stringify([{ type: "text", text: "Hello 🚀 World 🌍" }]);
    assert.equal(extractTextFromContent(json), "Hello 🚀 World 🌍");
  });

  it("handles very long content blocks (4000+ chars)", () => {
    const longText = "A".repeat(4000) + "\n" + "B".repeat(4000);
    const json = JSON.stringify([{ type: "text", text: longText }]);
    assert.equal(extractTextFromContent(json), longText);
  });

  it("handles mixed newlines and markdown formatting", () => {
    const text = "# Title\n\n━━━━━━━━\n\n**Bold** and *italic*\n\n- Item 1\n- Item 2";
    const json = JSON.stringify([{ type: "text", text }]);
    assert.equal(extractTextFromContent(json), text);
  });
});
