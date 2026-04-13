import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

const PORT = process.env.PORT || 8787;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const OPENAI_FAST_MODEL = process.env.OPENAI_FAST_MODEL || "gpt-4.1";
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 5000);
const DEFAULT_PROVIDER = process.env.LAYOUT_PROVIDER || "openai";
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || "";
const CLIENT_API_SECRET_KEY = process.env.CLIENT_API_SECRET_KEY || "";
const EXTENSION_AUTH_SIGNING_KEY = process.env.EXTENSION_AUTH_SIGNING_KEY || CLIENT_API_SECRET_KEY;
const EXTENSION_TOKEN_TTL_SEC = Number(process.env.EXTENSION_TOKEN_TTL_SEC || 15 * 60);
const ALLOWED_EXTENSION_IDS = String(process.env.ALLOWED_EXTENSION_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const SPROCKET_BASE_URL = "https://app.sprocketrocket.co/portals-main?models=";
const URL_CAPTURE_TIMEOUT_MS = Number(process.env.URL_CAPTURE_TIMEOUT_MS || 0);
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 0);
const OPENAI_REQUEST_TIMEOUT_MS_CLIENT = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS_CLIENT || 0);
const OPENAI_LOG_RESPONSES = String(process.env.OPENAI_LOG_RESPONSES || "1") === "1";
const URL_MODE_FULL_PAGE = String(process.env.URL_MODE_FULL_PAGE || "true") === "true";
const URL_SCREENSHOT_QUALITY = Number(process.env.URL_SCREENSHOT_QUALITY || 55);
const CHROME_EXECUTABLE_OVERRIDE = process.env.CHROME_EXECUTABLE_PATH || "";
const JOB_STALE_TIMEOUT_MS = Number(process.env.JOB_STALE_TIMEOUT_MS || 5 * 60 * 1000);
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_TOKEN = process.env.REDIS_TOKEN || "";
const REDIS_JOB_PREFIX = process.env.REDIS_JOB_PREFIX || "ditto:job:";
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 30 * 60 * 1000);
const JOB_TTL_SEC = Math.max(60, Math.round(JOB_TTL_MS / 1000));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ─── Typography-Only Extraction (No AI) ─────────────────────────────
app.post("/api/typography", async (req, res) => {
  try {
    console.log("[API] /api/typography request received");
    const websiteUrl = String(req.body?.website_url || "").trim();

    if (!websiteUrl) {
      return res.status(400).json({ error: "website_url is required" });
    }

    const result = await extractTypographyFromUrl(websiteUrl);
    return res.json(result);
  } catch (error) {
    console.error("[API] /api/typography error:", error.message || "Unknown error");
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

// GET version for easy browser/HubSpot access
app.get("/api/typography", async (req, res) => {
  try {
    const websiteUrl = String(req.query?.url || "").trim();
    if (!websiteUrl) {
      return res.status(400).json({
        error: "url query parameter is required.",
        example: "/api/typography?url=https://example.com"
      });
    }
    const result = await extractTypographyFromUrl(websiteUrl);
    return res.json(result);
  } catch (error) {
    console.error("[API] GET /api/typography error:", error.message || "Unknown error");
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});


app.post("/api/auth/extension/session", (req, res) => {
  try {
    const extensionId = String(req.body?.extension_id || req.headers["x-extension-id"] || "").trim();
    if (!extensionId) {
      return res.status(400).json({ error: "extension_id is required" });
    }
    if (!EXTENSION_AUTH_SIGNING_KEY) {
      return res.status(500).json({ error: "EXTENSION_AUTH_SIGNING_KEY is not configured on server." });
    }
    if (ALLOWED_EXTENSION_IDS.length && !ALLOWED_EXTENSION_IDS.includes(extensionId)) {
      return res.status(403).json({ error: "Extension is not allowed." });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtHS256(
      {
        iss: "reference-capture-backend",
        aud: "reference-capture-extension",
        sub: extensionId,
        iat: now,
        exp: now + EXTENSION_TOKEN_TTL_SEC
      },
      EXTENSION_AUTH_SIGNING_KEY
    );
    return res.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: EXTENSION_TOKEN_TTL_SEC
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.post("/api/markout", async (req, res) => {
  try {
    console.log("[API] /api/markout request received");
    const image = req.body?.image;
    const websiteUrl = String(req.body?.website_url || "").trim();

    if (websiteUrl) {
      const providedSecret = String(req.query?.secret_key || req.body?.secret_key || "").trim();

      const bearer = extractBearerToken(req.headers?.authorization);
      const querySecretValid = Boolean(
        CLIENT_API_SECRET_KEY && providedSecret && providedSecret === CLIENT_API_SECRET_KEY && req.query?.secret_key
      );
      const extensionId = String(req.headers["x-extension-id"] || "").trim();
      const extensionAuthValid = bearer
        ? verifyBackendIssuedToken(bearer, {
          signingKey: EXTENSION_AUTH_SIGNING_KEY,
          expectedAud: "reference-capture-extension",
          expectedIss: "reference-capture-backend",
          expectedSub: extensionId,
          allowlist: ALLOWED_EXTENSION_IDS
        })
        : false;
      const isAuthorized = querySecretValid || extensionAuthValid;

      if (!isAuthorized) {
        return res.status(401).json({ error: "Unauthorized request." });
      }

      const provider = req.body?.provider || "openai";
      const job = await createJob({ website_url: websiteUrl, provider });
      queueRunJob(job.id);
      return res.json(buildJobResponse(job.id, req));
    }

    if (!image) {
      return res.status(400).json({ error: "image or website_url is required" });
    }

    const startedAt = Date.now();
    const result = await analyzeAndMatchModules({
      image,
      page: req.body?.page || {},
      previewWidth: Number(req.body?.previewWidth) || 0,
      previewHeight: Number(req.body?.previewHeight) || 0,
      provider: req.body?.provider || DEFAULT_PROVIDER
    });
    console.log("[API] /api/markout response final_url:", result.final_url || "");
    return res.json({
      ...result,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error("[API] /api/markout error:", error.message || "Unknown error");
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
});

app.get("/ditto/status", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const jobId = String(req.query?.jobid || "");
  const job = await getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status === "queued") {
    queueRunJob(job.id);
  }
  if (job.status === "running") {
    const updatedAtMs = Date.parse(job.updated_at || "") || 0;
    if (updatedAtMs > 0 && Date.now() - updatedAtMs > JOB_STALE_TIMEOUT_MS) {
      await updateJob(jobId, {
        status: "failed",
        stage: "failed",
        progress: 100,
        completed_at: new Date().toISOString(),
        message: "Job timed out while processing. Please retry.",
        error: "Job timed out while processing."
      });
    }
  }
  const latest = (await getJob(jobId)) || job;
  return res.json({
    job_id: latest.id,
    status: latest.status,
    progress: latest.progress,
    stage: latest.stage,
    message: latest.message,
    started_at: latest.started_at,
    completed_at: latest.completed_at,
    final_url: latest.result?.final_url || "",
    error: latest.error || ""
  });
});

app.get("/ditto/result", async (req, res) => {
  const jobId = String(req.query?.jobid || "");
  const job = await getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status === "queued") {
    queueRunJob(job.id);
  }
  if (job.status !== "completed") {
    return res.status(202).json({
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      error: job.error || ""
    });
  }
  return res.json({
    job_id: job.id,
    ...job.result
  });
});

app.get("/ditto/status-ui", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "status.html"));
});
app.use("/ditto", express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

let catalogCache = null;
let sharedBrowser = null;
const jobs = new Map();
let redisClientPromise = null;
if (!USE_REDIS) {
  setInterval(cleanupJobs, 60 * 1000).unref();
}

async function createJob({ website_url, provider }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    progress: 5,
    stage: "queued",
    message: "Job queued.",
    website_url,
    provider,
    created_at: now,
    updated_at: now,
    started_at: "",
    completed_at: "",
    error: "",
    result: null,
    expires_at: Date.now() + JOB_TTL_MS
  };
  await setJob(job);
  return job;
}

function buildJobResponse(jobId, req) {
  const base = req ? `${req.protocol}://${req.get("host")}` : `http://localhost:${PORT}`;
  return {
    job_id: jobId,
    status: "queued",
    status_url: `${base}/ditto/status?jobid=${encodeURIComponent(jobId)}`,
    status_ui_url: `${base}/ditto/status-ui?jobid=${encodeURIComponent(jobId)}`
  };
}

function extractBearerToken(authHeader) {
  const raw = String(authHeader || "").trim();
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function verifyBackendIssuedToken(token, options) {
  const {
    signingKey,
    expectedAud,
    expectedIss,
    expectedSub,
    allowlist
  } = options || {};
  if (!token || !signingKey || !expectedSub) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const headerJson = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    const payloadJson = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
    if (headerJson?.alg !== "HS256" || headerJson?.typ !== "JWT") return false;
    const now = Math.floor(Date.now() / 1000);
    if (!payloadJson?.exp || now >= Number(payloadJson.exp)) return false;
    if (payloadJson?.iss !== expectedIss) return false;
    if (payloadJson?.aud !== expectedAud) return false;
    if (payloadJson?.sub !== expectedSub) return false;
    if (Array.isArray(allowlist) && allowlist.length && !allowlist.includes(expectedSub)) return false;

    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = createHmac("sha256", signingKey).update(signingInput).digest();
    const actualSig = base64UrlDecode(signatureB64);
    if (expectedSig.length !== actualSig.length) return false;
    return timingSafeEqual(expectedSig, actualSig);
  } catch {
    return false;
  }
}

function signJwtHS256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), "utf8"));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload || {}), "utf8"));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  const signatureB64 = base64UrlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const b64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${b64}${"=".repeat((4 - (b64.length % 4 || 4)) % 4)}`;
  return Buffer.from(padded, "base64");
}

async function updateJob(jobId, patch) {
  const current = await getJob(jobId);
  if (!current) return;
  const next = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString()
  };
  await setJob(next);
}

function cleanupJobs() {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.expires_at <= now) {
      jobs.delete(jobId);
    }
  }
}

function queueRunJob(jobId) {
  setImmediate(async () => {
    await processJob(jobId);
  });
}

async function processJob(jobId) {
  const current = await getJob(jobId);
  if (!current) return;
  if (current.status === "completed" || current.status === "failed") return;
  if (current.status === "running") return;

  try {
    await updateJob(jobId, {
      started_at: current.started_at || new Date().toISOString(),
      status: "running",
      stage: "scanning",
      progress: 15,
      message: "Scanning website."
    });
    const job = await getJob(jobId);
    if (!job) return;

    const result = await analyzeWebsiteUrl({
      websiteUrl: job.website_url,
      provider: job.provider,
      onProgress: (state) => {
        void updateJob(jobId, state);
      }
    });
    await updateJob(jobId, {
      status: "completed",
      stage: "completed",
      progress: 100,
      message: "Done. Redirecting to Ditto platform.",
      completed_at: new Date().toISOString(),
      result
    });
  } catch (error) {
    await updateJob(jobId, {
      status: "failed",
      stage: "failed",
      progress: 100,
      message: "Job failed.",
      completed_at: new Date().toISOString(),
      error: error?.message || "Unknown error"
    });
  }
}

async function getJob(jobId) {
  if (!jobId) return null;
  if (!USE_REDIS) {
    return jobs.get(jobId) || null;
  }
  const redis = await getRedisClient();
  const key = `${REDIS_JOB_PREFIX}${jobId}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  if (typeof raw === "string") {
    return JSON.parse(raw);
  }
  return raw;
}

async function setJob(job) {
  if (!job?.id) return;
  if (!USE_REDIS) {
    jobs.set(job.id, job);
    return;
  }
  const redis = await getRedisClient();
  const key = `${REDIS_JOB_PREFIX}${job.id}`;
  await redis.set(key, job, { ex: JOB_TTL_SEC });
}

async function getRedisClient() {
  if (redisClientPromise) return redisClientPromise;
  redisClientPromise = (async () => {
    const { Redis } = await import("@upstash/redis");
    return new Redis({
      url: REDIS_URL,
      token: REDIS_TOKEN
    });
  })();
  return redisClientPromise;
}

async function extractTypographyFromUrl(websiteUrl) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(websiteUrl);
  } catch {
    throw new Error("website_url must be a valid absolute URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("website_url must start with http:// or https://");
  }

  const startedAt = Date.now();
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  try {
    const gotoOptions = { waitUntil: "domcontentloaded" };
    if (Number.isFinite(URL_CAPTURE_TIMEOUT_MS) && URL_CAPTURE_TIMEOUT_MS > 0) {
      gotoOptions.timeout = URL_CAPTURE_TIMEOUT_MS;
    }
    await page.goto(parsedUrl.toString(), gotoOptions);
    await page.waitForTimeout(200);

    const pageTitle = await page.title();
    const finalPageUrl = page.url();

    const typographyData = await page.evaluate(() => {
      const typography = {
        fonts: { headings: "", body: "" },
        headings: {},
        body: {},
        links: {},
        buttons: {},
        colors: { text: [], background: [], primary: "" },
        google_fonts_urls: []
      };
      try {
        const gs = (el, p) => el ? window.getComputedStyle(el)[p] : "";
        const hex = (rgb) => {
          if (!rgb || rgb === "transparent" || rgb === "rgba(0, 0, 0, 0)") return "";
          const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) return rgb;
          return "#" + [m[1], m[2], m[3]].map(c => parseInt(c).toString(16).padStart(2, "0")).join("");
        };
        // Per-heading styles
        for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
          const el = document.querySelector(tag);
          if (el) {
            const s = window.getComputedStyle(el);
            typography.headings[tag] = {
              fontFamily: s.fontFamily,
              fontSize: s.fontSize,
              fontWeight: s.fontWeight,
              lineHeight: s.lineHeight,
              letterSpacing: s.letterSpacing,
              color: hex(s.color)
            };
          }
        }
        const fh = document.querySelector("h1, h2, h3");
        const fp = document.querySelector("p");
        if (fh) typography.fonts.headings = gs(fh, "fontFamily");
        if (fp) typography.fonts.body = gs(fp, "fontFamily");
        if (fp) {
          const s = window.getComputedStyle(fp);
          typography.body = {
            fontFamily: s.fontFamily,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            lineHeight: s.lineHeight,
            letterSpacing: s.letterSpacing,
            color: hex(s.color)
          };
        }
        const lnk = document.querySelector("a[href]");
        if (lnk) {
          const s = window.getComputedStyle(lnk);
          typography.links = { color: hex(s.color), textDecoration: s.textDecorationLine || s.textDecoration, fontWeight: s.fontWeight };
        }
        const btn = document.querySelector("button, a.btn, a[class*='btn'], [class*='button'], input[type='submit']");
        if (btn) {
          const s = window.getComputedStyle(btn);
          typography.buttons = {
            fontFamily: s.fontFamily,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            color: hex(s.color),
            backgroundColor: hex(s.backgroundColor),
            borderRadius: s.borderRadius
          };
        }
        // Collect colors
        const tc = new Set(), bc = new Set();
        document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,li,button,a,section,header,footer,div").forEach((el, i) => {
          if (i > 200) return;
          const s = window.getComputedStyle(el);
          const t = hex(s.color), b = hex(s.backgroundColor);
          if (t) tc.add(t);
          if (b) bc.add(b);
        });
        typography.colors.text = Array.from(tc).slice(0, 10);
        typography.colors.background = Array.from(bc).slice(0, 10);
        if (typography.buttons.backgroundColor) typography.colors.primary = typography.buttons.backgroundColor;
        // Google Fonts
        document.querySelectorAll("link[href*='fonts.googleapis.com'], link[href*='fonts.gstatic.com']").forEach(l => {
          if (l.href) typography.google_fonts_urls.push(l.href);
        });
        try {
          for (const sh of document.styleSheets) {
            try {
              for (const r of sh.cssRules || []) {
                if (r.type === CSSRule.IMPORT_RULE && r.href && /fonts\.googleapis\.com/i.test(r.href)) {
                  typography.google_fonts_urls.push(r.href);
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
        typography.google_fonts_urls = [...new Set(typography.google_fonts_urls)];
      } catch (e) { /* ignore */ }
      return typography;
    });

    return {
      success: true,
      website_url: finalPageUrl || parsedUrl.toString(),
      page_title: pageTitle || "",
      typography: typographyData,
      elapsed_ms: Date.now() - startedAt
    };
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }
}

async function analyzeWebsiteUrl({ websiteUrl, provider, onProgress }) {
  onProgress?.({
    status: "running",
    stage: "scanning",
    progress: 25,
    message: "Capturing website layout."
  });
  const capture = await captureWebsiteScreenshot(websiteUrl);
  const expectedMinModules = estimateExpectedModules(capture.page?.scroll_height);
  onProgress?.({
    status: "running",
    stage: "analyzing",
    progress: 55,
    message: "Analyzing modules with AI."
  });
  return analyzeAndMatchModules({
    image: capture.imageDataUrl,
    page: capture.page,
    previewWidth: capture.previewWidth,
    previewHeight: capture.previewHeight,
    provider: provider || "google_vision",
    openaiModel: OPENAI_FAST_MODEL,
    openaiTimeoutMs: OPENAI_REQUEST_TIMEOUT_MS_CLIENT,
    compactPrompt: true,
    expectedMinModules,
    onProgress
  });
}

async function captureWebsiteScreenshot(websiteUrl) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(websiteUrl);
  } catch {
    throw new Error("website_url must be a valid absolute URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("website_url must start with http:// or https://");
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  try {
    const gotoOptions = {
      waitUntil: "domcontentloaded"
    };
    if (Number.isFinite(URL_CAPTURE_TIMEOUT_MS) && URL_CAPTURE_TIMEOUT_MS > 0) {
      gotoOptions.timeout = URL_CAPTURE_TIMEOUT_MS;
    }
    await page.goto(parsedUrl.toString(), gotoOptions);
    await page.waitForTimeout(120);

    const png = await page.screenshot({
      type: "jpeg",
      quality: URL_SCREENSHOT_QUALITY,
      fullPage: URL_MODE_FULL_PAGE
    });
    const pngSize = getPngSize(png);
    const pageTitle = await page.title();
    const finalPageUrl = page.url();
    const domMeta = await page.evaluate(() => {
      const scrollHeight = Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        document.documentElement?.clientHeight || 0,
        window.innerHeight || 0
      );
      const footerEl = document.querySelector("footer");
      const footerText = (footerEl?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const sectionNodes = Array.from(document.querySelectorAll("main section, section, footer, header"));
      const sectionHints = sectionNodes.slice(0, 24).map((node) => {
        const rect = node.getBoundingClientRect();
        const top = Math.max(0, rect.top + window.scrollY);
        const text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
        return {
          tag: node.tagName.toLowerCase(),
          y: Math.round(top),
          text
        };
      });

      return {
        scrollHeight,
        footerText,
        sectionHints
      };
    });

    return {
      imageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      previewWidth: pngSize.width,
      previewHeight: pngSize.height,
      page: {
        url: finalPageUrl || parsedUrl.toString(),
        title: pageTitle || "",
        viewport: { width: 1366, height: 900 },
        captured_at: new Date().toISOString(),
        scroll_height: domMeta.scrollHeight,
        capture_id: `api-${Date.now()}`,
        dom_hints: {
          footer_text: domMeta.footerText,
          section_hints: domMeta.sectionHints
        }
      }
    };
  } finally {
    try {
      await context.close();
    } catch {
      // Ignore cleanup errors if browser/context is already closed.
    }
  }
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }
  const { chromium } = await import("playwright");
  try {
    sharedBrowser = await chromium.launch({ headless: true });
    return sharedBrowser;
  } catch (error) {
    const fallbackPaths = [
      CHROME_EXECUTABLE_OVERRIDE,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ].filter(Boolean);

    for (const executablePath of fallbackPaths) {
      try {
        sharedBrowser = await chromium.launch({
          headless: true,
          executablePath
        });
        console.log("[API] Playwright fallback browser:", executablePath);
        return sharedBrowser;
      } catch {
        // Try next fallback path.
      }
    }
    throw error;
  }
}

async function analyzeAndMatchModules({
  image,
  page,
  previewWidth,
  previewHeight,
  provider,
  openaiModel,
  openaiTimeoutMs,
  compactPrompt,
  expectedMinModules,
  onProgress
}) {
  const catalog = await loadModuleCatalog();
  onProgress?.({
    status: "running",
    stage: "analyzing",
    progress: 62,
    message: "Extracting page signals."
  });
  const vision = await fetchGoogleVisionInsights(image, provider);
  onProgress?.({
    status: "running",
    stage: "matching",
    progress: 78,
    message: "Matching modules against catalog."
  });
  const aiResult = await fetchOpenAIModuleMatch({
    image,
    page,
    previewWidth,
    previewHeight,
    vision,
    catalog,
    openaiModel,
    openaiTimeoutMs,
    compactPrompt,
    expectedMinModules,
    onProgress
  });

  const normalized = normalizeMatches(aiResult, catalog);
  const matchedModules = normalized.ordered_module_names;
  const modelIds = matchedModules.map(moduleNameToModelId).filter(Boolean);
  const matchedModulesCsv = matchedModules.join(",");
  const finalUrl = `${SPROCKET_BASE_URL}${matchedModulesCsv}`;
  const finalUrlModelIds = `${SPROCKET_BASE_URL}${modelIds.join(",")}`;
  onProgress?.({
    status: "running",
    stage: "finalizing",
    progress: 92,
    message: "Building final Ditto URL."
  });
  console.log("[API] Final URL:", finalUrl);

  return {
    markout_version: "v2",
    page,
    lines: normalized.lines,
    blocks: normalized.matches.map((item, index) => ({
      id: `module-${index + 1}`,
      type: categoryToBlockType(item.category),
      name: item.module_name,
      confidence: item.confidence,
      source: "vision+openai"
    })),
    matched_modules: matchedModules,
    matched_modules_csv: matchedModulesCsv,
    model_ids: modelIds,
    final_url: finalUrl,
    final_url_model_ids: finalUrlModelIds,
    vision: {
      provider_used: vision.provider_used,
      had_ocr_text: Boolean(vision.ocr_text),
      object_count: vision.objects.length,
      logo_count: vision.logos.length,
      warning: vision.warning || ""
    },
    warnings: vision.warning ? [vision.warning] : []
  };
}

async function loadModuleCatalog() {
  if (catalogCache) return catalogCache;
  const filePath = path.join(__dirname, "modules.json");
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const modules = Array.isArray(parsed?.modules) ? parsed.modules : [];
  catalogCache = modules
    .map((item) => ({
      name: item?.name || "",
      description: item?.description || "",
      category: item?.category || "unknown",
      image_url: item?.image_url || item?.imageUrl || item?.url || "",
      image_hint: deriveImageHint(item?.image_url || item?.imageUrl || item?.url || "")
    }))
    .filter((item) => item.name);
  return catalogCache;
}

async function fetchGoogleVisionInsights(imageDataUrl, provider = "") {
  const canUseVision =
    (provider === "google_vision" || provider === "backend" || provider === "hybrid" || !provider) &&
    Boolean(GOOGLE_VISION_API_KEY);
  if (!canUseVision) {
    return { provider_used: "none", ocr_text: "", objects: [], logos: [] };
  }

  const content = dataUrlToBase64(imageDataUrl);
  if (!content) {
    return { provider_used: "none", ocr_text: "", objects: [], logos: [] };
  }

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`;
  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content },
          features: [
            { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 },
            { type: "OBJECT_LOCALIZATION", maxResults: 30 },
            { type: "LOGO_DETECTION", maxResults: 20 }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await safeReadText(response);
    const status = response.status;
    const isPermissionIssue =
      status === 401 ||
      status === 403 ||
      /PERMISSION_DENIED|API_KEY_SERVICE_BLOCKED|blocked/i.test(errorBody);
    if (isPermissionIssue) {
      return {
        provider_used: "openai_fallback",
        ocr_text: "",
        objects: [],
        logos: [],
        warning: `Google Vision unavailable (${status}). Falling back to OpenAI-only analysis.`
      };
    }
    throw new Error(`Google Vision request failed (${status}): ${errorBody}`);
  }

  const payload = await response.json();
  const first = Array.isArray(payload?.responses) ? payload.responses[0] : null;
  const ocrText =
    (typeof first?.fullTextAnnotation?.text === "string" && first.fullTextAnnotation.text) ||
    (typeof first?.textAnnotations?.[0]?.description === "string" && first.textAnnotations[0].description) ||
    "";
  const objects = Array.isArray(first?.localizedObjectAnnotations)
    ? first.localizedObjectAnnotations.map((item) => item?.name).filter(Boolean)
    : [];
  const logos = Array.isArray(first?.logoAnnotations)
    ? first.logoAnnotations.map((item) => item?.description).filter(Boolean)
    : [];

  return {
    provider_used: "google_vision",
    ocr_text: ocrText.slice(0, 8000),
    objects: objects.slice(0, 40),
    logos: logos.slice(0, 30)
  };
}

async function fetchOpenAIModuleMatch({
  image,
  page,
  previewWidth,
  previewHeight,
  vision,
  catalog,
  openaiModel,
  openaiTimeoutMs,
  compactPrompt,
  expectedMinModules,
  onProgress
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing.");
  }
  const catalogText = compactPrompt
    ? catalog
      .map(
        (item, index) =>
          `${index + 1}. name="${item.name}" | category="${item.category}" | image_hint="${item.image_hint}"`
      )
      .join("\n")
    : catalog
      .map(
        (item, index) =>
          `${index + 1}. name="${item.name}" | category="${item.category}" | description="${item.description}" | image_url="${item.image_url}" | image_hint="${item.image_hint}"`
      )
      .join("\n");

  const visionText = [
    `Google Vision provider: ${vision.provider_used}`,
    `OCR text (truncated): ${vision.ocr_text || "none"}`,
    `Detected objects: ${vision.objects.join(", ") || "none"}`,
    `Detected logos: ${vision.logos.join(", ") || "none"}`
  ].join("\n");

  const prompt = [
    "You are an expert web page module matcher.",
    "Return JSON only (no markdown).",
    "Required shape:",
    "{",
    '  "lines": [number],',
    '  "matches": [',
    "    {",
    '      "module_name": string,',
    '      "category": string,',
    '      "confidence": number,',
    '      "y_start": number,',
    '      "y_end": number',
    "    }",
    "  ],",
    '  "ordered_module_names": [string]',
    "}",
    "Task:",
    "- Segment the screenshot into modules from top to bottom.",
    "- For each segment, choose the single closest module from catalog.",
    "- module_name MUST match one catalog name exactly.",
    "- Keep ordered_module_names in page order and include duplicates only if clearly repeated.",
    "- Once a footer module is reached, do not add non-footer modules after it.",
    "- Cover the whole visible page from top navigation to footer (not only first viewport).",
    `- Return at least ${Math.max(3, Number(expectedMinModules) || 3)} modules when the page has many sections.`,
    "- Prefer precise matches for hero, pricing, testimonial, FAQ, nav, footer patterns.",
    "- confidence must be 0..1.",
    `Image size (px): ${previewWidth}x${previewHeight}.`,
    "lines are pixel y-positions relative to the provided image.",
    `Page metadata: ${JSON.stringify(page || {})}`,
    "",
    "Google Vision signals:",
    visionText,
    "",
    "Module catalog:",
    catalogText
  ].join("\n");

  const controller = new AbortController();
  onProgress?.({
    status: "running",
    stage: "matching",
    progress: 84,
    message: "Running AI module selection."
  });
  const resolvedTimeoutMs = Number(openaiTimeoutMs ?? OPENAI_REQUEST_TIMEOUT_MS);
  const useTimeout = Number.isFinite(resolvedTimeoutMs) && resolvedTimeoutMs > 0;
  const timeout = useTimeout ? setTimeout(() => controller.abort(), resolvedTimeoutMs) : null;
  let response = null;
  try {
    response = await fetchWithRetry(OPENAI_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: openaiModel || OPENAI_MODEL,
        max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: image }
            ]
          }
        ]
      }),
      ...(useTimeout ? { signal: controller.signal } : {})
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = await safeReadText(response);
    throw new Error(`OpenAI request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("OpenAI response missing output text.");
  }
  if (OPENAI_LOG_RESPONSES) {
    logOpenAIOutput("raw_output_text", outputText);
  }
  return parseOpenAIJson(outputText);
}

function normalizeMatches(aiResult, catalog) {
  const catalogMap = new Map(catalog.map((item) => [item.name, item]));
  const rawLines = Array.isArray(aiResult?.lines) ? aiResult.lines : [];
  const lines = [...new Set(rawLines.map((line) => Math.max(0, Math.round(Number(line) || 0))))]
    .sort((a, b) => a - b)
    .slice(0, 40);

  const rawMatches = Array.isArray(aiResult?.matches) ? aiResult.matches : [];
  const matches = rawMatches
    .map((item) => {
      const moduleName = typeof item?.module_name === "string" ? item.module_name.trim() : "";
      const moduleFromCatalog = catalogMap.get(moduleName);
      if (!moduleFromCatalog) {
        return null;
      }
      return {
        module_name: moduleFromCatalog.name,
        category: moduleFromCatalog.category,
        confidence: clamp01(Number(item?.confidence) || 0.5),
        y_start: Number(item?.y_start) || 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.y_start - b.y_start);

  let ordered = Array.isArray(aiResult?.ordered_module_names)
    ? aiResult.ordered_module_names
      .map((name) => (typeof name === "string" ? name.trim() : ""))
      .filter((name) => catalogMap.has(name))
    : [];

  if (!ordered.length) {
    ordered = matches.map((item) => item.module_name);
  }
  ordered = pruneModulesAfterFooter(ordered, catalogMap);
  if (!ordered.length && catalog.length) {
    ordered = [catalog[0].name];
  }

  return {
    lines,
    matches,
    ordered_module_names: ordered
  };
}

function pruneModulesAfterFooter(ordered, catalogMap) {
  if (!Array.isArray(ordered) || !ordered.length) return [];
  const firstFooterIndex = ordered.findIndex((name) => isFooterModule(name, catalogMap));
  if (firstFooterIndex < 0) return ordered;
  const head = ordered.slice(0, firstFooterIndex + 1);
  const tail = ordered.slice(firstFooterIndex + 1).filter((name) => isFooterModule(name, catalogMap));
  const pruned = [...head, ...tail];
  return [...new Set(pruned.map((item) => String(item || "").trim()).filter(Boolean))];
}

function isFooterModule(name, catalogMap) {
  const moduleName = String(name || "");
  const module = catalogMap.get(moduleName);
  const category = String(module?.category || "").toLowerCase();
  return /footer/i.test(moduleName) || category === "footer";
}

function deriveImageHint(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const noQuery = raw.split("?")[0];
  const file = noQuery.split("/").pop() || "";
  return file.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
}

function moduleNameToModelId(name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "";
  if (/-\d{2}-10$/.test(normalized)) return normalized;
  if (/-\d{2}$/.test(normalized)) return `${normalized}-10`;
  return `${normalized}-10`;
}

function categoryToBlockType(category) {
  const value = String(category || "").toUpperCase();
  if (value === "HERO") return "HERO";
  if (value === "FOOTER") return "FOOTER";
  if (value === "NAVIGATION") return "NAV";
  if (value === "CARDS") return "FEATURES";
  if (value === "TABS") return "CONTENT";
  if (value === "OFFERS") return "CTA";
  if (value === "BLING") return "CONTENT";
  return "CONTENT";
}

function dataUrlToBase64(dataUrl) {
  if (typeof dataUrl !== "string") return "";
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return "";
  return dataUrl.slice(commaIndex + 1);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return { width: 1366, height: 900 };
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1366, height: 900 };
  }
  return { width, height };
}

function estimateExpectedModules(scrollHeight) {
  const h = Number(scrollHeight) || 0;
  if (h <= 0) return 6;
  const estimated = Math.round(h / 700);
  return Math.max(6, Math.min(20, estimated));
}

function extractOutputText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string") return response.output_text;
  const outputs = Array.isArray(response.output) ? response.output : [];
  for (const output of outputs) {
    const content = Array.isArray(output.content) ? output.content : [];
    for (const item of content) {
      if (item?.type === "output_text" && typeof item.text === "string") {
        return item.text;
      }
      if (item?.type === "text" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return "";
}

function parseOpenAIJson(outputText) {
  const raw = String(outputText || "").trim();
  if (!raw) {
    throw new Error("OpenAI response was not valid JSON.");
  }

  const direct = tryParseJson(raw);
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed) return parsed;
  }

  const objectCandidate = extractTopLevelJsonObject(raw);
  if (objectCandidate) {
    const parsed = tryParseJson(objectCandidate);
    if (parsed) return parsed;

    // Common model glitch: trailing commas before } or ]
    const repaired = objectCandidate.replace(/,\s*([}\]])/g, "$1");
    const repairedParsed = tryParseJson(repaired);
    if (repairedParsed) return repairedParsed;
  }

  if (OPENAI_LOG_RESPONSES) {
    logOpenAIOutput("parse_failed_output_text", raw);
  }
  const seemsTruncated = raw.includes("\"module_name") && !raw.trim().endsWith("}");
  if (seemsTruncated) {
    throw new Error("OpenAI response was truncated before valid JSON completion.");
  }
  throw new Error("OpenAI response was not valid JSON.");
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTopLevelJsonObject(text) {
  const first = text.indexOf("{");
  if (first < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) {
      return text.slice(first, i + 1);
    }
  }
  return "";
}

function logOpenAIOutput(label, text) {
  const raw = String(text || "");
  const maxChars = 12000;
  const clipped = raw.length > maxChars;
  const display = clipped ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw;
  console.log(`[OPENAI_DEBUG] ${label} (${raw.length} chars):\n${display}`);
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, options);
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        lastError = new Error(`Upstream ${res.status}`);
      } else {
        return res;
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("OpenAI request timeout.");
      }
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
  }
  throw lastError || new Error("Upstream request failed.");
}
