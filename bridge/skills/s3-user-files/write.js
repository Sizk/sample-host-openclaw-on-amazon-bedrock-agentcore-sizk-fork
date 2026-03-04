#!/usr/bin/env node
const fs = require('fs');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const {
  BUCKET,
  REGION,
  buildKey,
  validateUserId,
  validateBucket,
} = require("./common");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function getContentType(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const types = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    csv: "text/csv",
    json: "application/json",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    xml: "application/xml",
    zip: "application/zip",
  };
  return types[ext] || "application/octet-stream";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const userId = process.argv[2];
  const filename = process.argv[3];
  const argContent = process.argv.slice(4).join(" ");

  validateUserId(userId);
  validateBucket();

  if (!filename) {
    console.error("Error: filename argument is required.");
    process.exit(1);
  }

  let body;

  if (argContent === "--stdin") {
    body = await readStdin();
  } else if (argContent.startsWith("--file=")) {
    const filePath = argContent.slice(7);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    body = fs.readFileSync(filePath);
  } else {
    body = argContent;
  }

  if (!body || (Buffer.isBuffer(body) && body.length === 0) || body === "") {
    console.error("Error: content is empty.");
    process.exit(1);
  }

  const size = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf-8");
  if (size > MAX_BYTES) {
    console.error(`Error: content exceeds maximum allowed size (${MAX_BYTES / 1024 / 1024} MB).`);
    process.exit(1);
  }

  const key = buildKey(userId, filename);
  const client = new S3Client({ region: REGION });

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: getContentType(filename),
    }),
  );

  console.log(`File written: ${key} (${size} bytes)`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
