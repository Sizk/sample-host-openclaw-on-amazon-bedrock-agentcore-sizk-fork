/**
 * Tests for extractFileMarkers from agentcore-contract.js.
 * Run: node --test file-markers.test.js
 *
 * Since extractFileMarkers is not exported (inline in the contract server),
 * we mirror the logic here — same pattern as content-extraction.test.js.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// --- Mirror of extractFileMarkers from agentcore-contract.js ---

function extractFileMarkers(responseText, namespace) {
  const files = [];
  const sanitize = (s) => {
    let r = s;
    while (r.includes("..")) r = r.replace(/\.\./g, "");
    return r.replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 256);
  };
  const CONTENT_TYPES = {
    pdf: "application/pdf",
    jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif", webp: "image/webp",
    csv: "text/csv", json: "application/json",
    txt: "text/plain", md: "text/markdown",
    html: "text/html", xml: "application/xml", zip: "application/zip",
  };
  const addFile = (filename) => {
    if (!filename) return;
    if (files.some((f) => f.filename === filename)) return;
    const ext = (filename.split(".").pop() || "").toLowerCase();
    files.push({
      s3Key: `${sanitize(namespace)}/${sanitize(filename)}`,
      filename,
      contentType: CONTENT_TYPES[ext] || "application/octet-stream",
    });
  };

  // Pass 1: Explicit [SEND_FILE:filename] markers
  const MARKER_RE = /\[SEND_FILE:([^\]]+)\]/g;
  let match;
  while ((match = MARKER_RE.exec(responseText)) !== null) {
    addFile(match[1].trim());
  }
  let cleanText = responseText.replace(MARKER_RE, "");

  // Pass 2: S3 presigned URLs and S3 URIs (fallback for model non-compliance)
  const bucket = process.env.S3_USER_FILES_BUCKET;
  if (bucket && namespace) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const S3_REF_RE = new RegExp(
      `(?:https?://[^\\s<>)\\]]*${esc(bucket)}[^\\s<>)\\]]*|s3://${esc(bucket)}/[^\\s<>)\\]]+)`,
      "gi",
    );
    let urlMatch;
    while ((urlMatch = S3_REF_RE.exec(cleanText)) !== null) {
      const url = urlMatch[0].replace(/[.,;:!?]+$/, "");
      const pathPart = url.split("?")[0];
      const nsIdx = pathPart.indexOf(namespace + "/");
      if (nsIdx >= 0) {
        const afterNs = pathPart.slice(nsIdx + namespace.length + 1);
        const rawName = afterNs.split("/").pop() || "";
        try {
          addFile(decodeURIComponent(rawName));
        } catch {
          addFile(rawName);
        }
      }
    }
    cleanText = cleanText.replace(S3_REF_RE, "");
  }

  cleanText = cleanText.replace(/[ \t]{2,}/g, " ").trim();
  return { files, cleanText };
}

// --- Tests ---

describe("extractFileMarkers — [SEND_FILE:] markers", () => {
  it("extracts a single marker", () => {
    const { files, cleanText } = extractFileMarkers(
      "Here is your report! [SEND_FILE:report.pdf]",
      "telegram_123",
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "report.pdf");
    assert.equal(files[0].s3Key, "telegram_123/report.pdf");
    assert.equal(files[0].contentType, "application/pdf");
    assert.equal(cleanText, "Here is your report!");
  });

  it("extracts multiple markers", () => {
    const { files, cleanText } = extractFileMarkers(
      "Files: [SEND_FILE:a.pdf] and [SEND_FILE:b.csv]",
      "ns",
    );
    assert.equal(files.length, 2);
    assert.equal(files[0].filename, "a.pdf");
    assert.equal(files[1].filename, "b.csv");
    assert.equal(files[1].contentType, "text/csv");
    assert.ok(!cleanText.includes("[SEND_FILE:"));
  });

  it("sanitizes path traversal in filename", () => {
    const { files } = extractFileMarkers(
      "[SEND_FILE:../../etc/passwd]",
      "ns",
    );
    assert.equal(files.length, 1);
    assert.ok(!files[0].s3Key.includes(".."));
  });

  it("deduplicates same filename", () => {
    const { files } = extractFileMarkers(
      "[SEND_FILE:x.pdf] again [SEND_FILE:x.pdf]",
      "ns",
    );
    assert.equal(files.length, 1);
  });

  it("returns empty files for text without markers", () => {
    const { files, cleanText } = extractFileMarkers("Hello world", "ns");
    assert.equal(files.length, 0);
    assert.equal(cleanText, "Hello world");
  });
});

describe("extractFileMarkers — S3 presigned URL fallback", () => {
  const BUCKET = "openclaw-user-files-123456789012-us-west-2";
  const NS = "telegram_999";

  beforeEach(() => {
    process.env.S3_USER_FILES_BUCKET = BUCKET;
  });
  afterEach(() => {
    delete process.env.S3_USER_FILES_BUCKET;
  });

  it("extracts file from presigned URL (virtual-hosted style)", () => {
    const url = `https://${BUCKET}.s3.us-west-2.amazonaws.com/${NS}/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIA...`;
    const { files, cleanText } = extractFileMarkers(
      `Here is your report: ${url}`,
      NS,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "report.pdf");
    assert.equal(files[0].s3Key, `${NS}/report.pdf`);
    assert.equal(files[0].contentType, "application/pdf");
    assert.ok(!cleanText.includes("amazonaws.com"));
  });

  it("extracts file from presigned URL (path style)", () => {
    const url = `https://s3.us-west-2.amazonaws.com/${BUCKET}/${NS}/data.csv?X-Amz-Algorithm=AWS4`;
    const { files, cleanText } = extractFileMarkers(
      `Download: ${url}`,
      NS,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "data.csv");
    assert.equal(files[0].contentType, "text/csv");
    assert.ok(!cleanText.includes("s3.us-west-2"));
  });

  it("extracts file from S3 URI", () => {
    const uri = `s3://${BUCKET}/${NS}/notes.md`;
    const { files, cleanText } = extractFileMarkers(
      `Saved to ${uri}`,
      NS,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "notes.md");
    assert.equal(files[0].contentType, "text/markdown");
    assert.ok(!cleanText.includes("s3://"));
  });

  it("extracts URL-encoded filenames", () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/${NS}/my%20report.pdf?X-Amz-Algorithm=AWS4`;
    const { files } = extractFileMarkers(`Here: ${url}`, NS);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "my report.pdf");
  });

  it("does not extract URLs from other buckets", () => {
    const url = "https://other-bucket.s3.amazonaws.com/ns/file.pdf";
    const { files } = extractFileMarkers(`Link: ${url}`, NS);
    assert.equal(files.length, 0);
  });

  it("does not extract URLs with wrong namespace", () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/other_namespace/file.pdf?X-Amz-Algorithm=AWS4`;
    const { files } = extractFileMarkers(`Link: ${url}`, NS);
    assert.equal(files.length, 0);
  });

  it("handles both marker and URL (dedup)", () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/${NS}/report.pdf?X-Amz-Sig=abc`;
    const { files } = extractFileMarkers(
      `Here: [SEND_FILE:report.pdf] also ${url}`,
      NS,
    );
    assert.equal(files.length, 1); // deduplicated
    assert.equal(files[0].filename, "report.pdf");
  });

  it("strips trailing punctuation from URLs", () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/${NS}/doc.txt?sig=abc`;
    const { files } = extractFileMarkers(
      `See ${url}.`,
      NS,
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "doc.txt");
  });

  it("does not match when bucket env var is not set", () => {
    delete process.env.S3_USER_FILES_BUCKET;
    const url = `https://${BUCKET}.s3.amazonaws.com/${NS}/report.pdf?sig=abc`;
    const { files } = extractFileMarkers(`Link: ${url}`, NS);
    assert.equal(files.length, 0);
  });

  it("cleans up double spaces after URL removal", () => {
    const url = `https://${BUCKET}.s3.amazonaws.com/${NS}/f.pdf?sig=x`;
    const { cleanText } = extractFileMarkers(
      `Report:  ${url}  done`,
      NS,
    );
    assert.ok(!cleanText.includes("  "));
  });
});
