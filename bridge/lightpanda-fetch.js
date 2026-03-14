/**
 * Lightpanda Web Fetcher — JS-rendering headless browser scraper.
 *
 * Uses the Lightpanda browser (10x faster, 10x less memory than Chrome)
 * via CDP (Chrome DevTools Protocol) with puppeteer-core.
 *
 * Falls back gracefully to basic HTTP fetch if Lightpanda is unavailable.
 */

const { spawn } = require("child_process");

const LIGHTPANDA_BINARY = "/usr/local/bin/lightpanda";
const LIGHTPANDA_PORT = 9222;
const LIGHTPANDA_TIMEOUT_MS = 30000; // 30s max per page
const MAX_CONTENT_LENGTH = 100000; // 100KB text output limit

// Lightpanda server process (started on demand, reused)
let lightpandaProcess = null;
let lightpandaReady = false;
let lightpandaStarting = false;
let lightpandaStartPromise = null;

/**
 * Start Lightpanda CDP server if not already running.
 * Returns true if ready, false on failure.
 */
async function ensureLightpandaRunning() {
  if (lightpandaReady && lightpandaProcess && !lightpandaProcess.killed) {
    return true;
  }
  if (lightpandaStarting && lightpandaStartPromise) {
    return lightpandaStartPromise;
  }

  lightpandaStarting = true;
  lightpandaStartPromise = new Promise((resolve) => {
    try {
      // Check if binary exists
      const fs = require("fs");
      if (!fs.existsSync(LIGHTPANDA_BINARY)) {
        console.warn("[lightpanda] Binary not found at", LIGHTPANDA_BINARY);
        lightpandaStarting = false;
        resolve(false);
        return;
      }

      console.log("[lightpanda] Starting CDP server on port", LIGHTPANDA_PORT);
      const proc = spawn(LIGHTPANDA_BINARY, [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(LIGHTPANDA_PORT),
        "--timeout", "30",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
      });

      lightpandaProcess = proc;
      let started = false;

      const startTimeout = setTimeout(() => {
        if (!started) {
          console.error("[lightpanda] Start timeout — killing process");
          proc.kill("SIGTERM");
          lightpandaStarting = false;
          resolve(false);
        }
      }, 10000);

      proc.stderr.on("data", (chunk) => {
        const line = chunk.toString();
        if (!started && (line.includes("server running") || line.includes("listening"))) {
          started = true;
          lightpandaReady = true;
          lightpandaStarting = false;
          clearTimeout(startTimeout);
          console.log("[lightpanda] CDP server ready");
          resolve(true);
        }
      });

      proc.stdout.on("data", (chunk) => {
        const line = chunk.toString();
        if (!started && (line.includes("server running") || line.includes("listening"))) {
          started = true;
          lightpandaReady = true;
          lightpandaStarting = false;
          clearTimeout(startTimeout);
          console.log("[lightpanda] CDP server ready");
          resolve(true);
        }
      });

      // Also try polling the server
      const pollInterval = setInterval(() => {
        if (started) {
          clearInterval(pollInterval);
          return;
        }
        const http = require("http");
        const req = http.get(`http://127.0.0.1:${LIGHTPANDA_PORT}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200 && !started) {
            started = true;
            lightpandaReady = true;
            lightpandaStarting = false;
            clearTimeout(startTimeout);
            clearInterval(pollInterval);
            console.log("[lightpanda] CDP server ready (detected via poll)");
            resolve(true);
          }
        });
        req.on("error", () => {}); // Not ready yet
        req.setTimeout(1000, () => req.destroy());
      }, 500);

      proc.on("exit", (code) => {
        console.log(`[lightpanda] Process exited with code ${code}`);
        lightpandaReady = false;
        lightpandaProcess = null;
        lightpandaStarting = false;
        clearInterval(pollInterval);
        if (!started) {
          clearTimeout(startTimeout);
          resolve(false);
        }
      });

      proc.on("error", (err) => {
        console.error(`[lightpanda] Process error: ${err.message}`);
        lightpandaStarting = false;
        clearInterval(pollInterval);
        if (!started) {
          clearTimeout(startTimeout);
          resolve(false);
        }
      });
    } catch (err) {
      console.error(`[lightpanda] Failed to start: ${err.message}`);
      lightpandaStarting = false;
      resolve(false);
    }
  });

  return lightpandaStartPromise;
}

/**
 * Fetch a URL using Lightpanda + puppeteer-core (renders JavaScript).
 *
 * Returns { text, html } or null if Lightpanda is unavailable.
 *
 * @param {string} url - URL to fetch
 * @param {object} options - { timeout, waitFor, extractMarkdown }
 */
async function fetchWithLightpanda(url, options = {}) {
  const timeout = options.timeout || LIGHTPANDA_TIMEOUT_MS;

  const ready = await ensureLightpandaRunning();
  if (!ready) return null;

  let browser, page;
  try {
    const puppeteer = require("puppeteer-core");
    browser = await puppeteer.connect({
      browserWSEndpoint: `ws://127.0.0.1:${LIGHTPANDA_PORT}`,
    });
    const context = await browser.createBrowserContext();
    page = await context.newPage();

    // Set reasonable viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate with timeout
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout,
    });

    // Optional: wait for specific selector
    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: 5000 }).catch(() => {});
    }

    // Extract page content
    const textContent = await page.evaluate(() => {
      // Remove script/style/noscript elements
      const elements = document.querySelectorAll("script, style, noscript, svg, iframe");
      elements.forEach((el) => el.remove());

      // Get clean text content
      return document.body ? document.body.innerText : "";
    });

    const title = await page.title();
    const pageUrl = page.url();

    await page.close();
    await context.close();
    await browser.disconnect();

    // Truncate if too long
    const truncated = textContent.length > MAX_CONTENT_LENGTH
      ? textContent.substring(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated at size limit]"
      : textContent;

    return {
      text: truncated || "(empty page)",
      title: title || "",
      url: pageUrl,
    };
  } catch (err) {
    console.error(`[lightpanda] Fetch failed for ${url}: ${err.message}`);
    // Clean up on error
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.disconnect(); } catch {}
    return null;
  }
}

/**
 * Stop the Lightpanda server (for cleanup on SIGTERM).
 */
function stopLightpanda() {
  if (lightpandaProcess) {
    try {
      lightpandaProcess.kill("SIGTERM");
    } catch {}
    lightpandaProcess = null;
    lightpandaReady = false;
  }
}

module.exports = {
  fetchWithLightpanda,
  ensureLightpandaRunning,
  stopLightpanda,
  isReady: () => lightpandaReady,
};
