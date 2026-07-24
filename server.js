const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const crypto = require("crypto");
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");
const { safeUnlink, isValidDownload, downloadFile } = require("./lib/fileUtils");
const { parseSpotifyUrl, joinArtists, firstImageUrl, buildSearchQuery, mapTrackToMetadata } = require("./lib/spotifyUtils");
const { runYtDlp, buildYtDlpArgs, extractErrorLine } = require("./lib/ytdlp");
const { normalizeCookies, analyzeCookieFile } = require("./lib/cookieUtils");
const NodeID3 = require("node-id3");

// â”€â”€â”€ Auto Cookie Update System â”€â”€â”€
let cookieAutoUpdateInterval = null;
let lastCookieUpdate = null;
let cookieUpdateCount = 0;

// Cookie update handlers (extensible for different providers)
const cookieProviders = {
  // Placeholder for cookie provider integration
  // Add your cookie provider API here
};

// Check if cookies need refresh (expiry-based or provider-based)
async function checkAndRefreshCookies() {
  const cookieFile = getCookieFile();
  const analysis = analyzeCookieFile(cookieFile);
  
  if (!analysis.configured) {
    console.log("[CookieAutoUpdate] No cookies configured, skipping refresh check");
    return { refreshed: false, reason: "no_cookies" };
  }
  
  // Check if using a cookie provider that auto-refreshes
  if (process.env.COOKIE_PROVIDER_URL) {
    console.log("[CookieAutoUpdate] Refreshing cookies from provider...");
    try {
      const newCookies = await fetchFromCookieProvider();
      if (newCookies) {
        fs.writeFileSync("/tmp/yt_cookies.txt", normalizeCookies(newCookies));
        cookieFilePath = "/tmp/yt_cookies.txt";
        lastCookieUpdate = Date.now();
        cookieUpdateCount++;
        console.log(`[CookieAutoUpdate] ✅ Cookies refreshed (count: ${cookieUpdateCount})`);
        return { refreshed: true, method: "provider" };
      }
    } catch (e) {
      console.log("[CookieAutoUpdate] ❌ Provider fetch failed:", e.message);
    }
  }
  
  // Check cookie age (warn if old)
  if (analysis.isAuthenticated) {
    console.log("[CookieAutoUpdate] Cookies appear valid, no refresh needed");
    return { refreshed: false, reason: "valid" };
  }
  
  return { refreshed: false, reason: "invalid" };
}

// Fetch cookies from external provider
async function fetchFromCookieProvider() {
  if (!process.env.COOKIE_PROVIDER_URL) return null;
  
  try {
    const response = await fetch(process.env.COOKIE_PROVIDER_URL, {
      headers: {
        "Authorization": `Bearer ${process.env.COOKIE_PROVIDER_KEY || ""}`,
        "Content-Type": "application/json"
      }
    });
    
    if (!response.ok) {
      throw new Error(`Provider returned ${response.status}`);
    }
    
    const data = await response.json();
    return data.cookies || data.cookie || data;
  } catch (e) {
    console.log("[CookieAutoUpdate] Provider fetch error:", e.message);
    return null;
  }
}

// Start the auto cookie update scheduler
function startCookieAutoUpdate(intervalMs = 30 * 60 * 1000) { // Default: 30 minutes
  if (cookieAutoUpdateInterval) {
    clearInterval(cookieAutoUpdateInterval);
  }
  
  // Initial check
  checkAndRefreshCookies();
  
  // Schedule periodic checks
  cookieAutoUpdateInterval = setInterval(checkAndRefreshCookies, intervalMs);
  console.log(`[CookieAutoUpdate] Started with ${intervalMs / 60000}min interval`);
}

// Stop the auto cookie update scheduler
function stopCookieAutoUpdate() {
  if (cookieAutoUpdateInterval) {
    clearInterval(cookieAutoUpdateInterval);
    cookieAutoUpdateInterval = null;
    console.log("[CookieAutoUpdate] Stopped");
  }
}

let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  // Try system ffmpeg first, then bundled ffmpeg-static
  const systemFfmpeg = "/usr/bin/ffmpeg";
  if (fs.existsSync(systemFfmpeg)) {
    ffmpegPath = systemFfmpeg;
  } else {
    ffmpegPath = require("ffmpeg-static");
  }
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {}

// Resolve a usable yt-dlp binary. Prefer the one bundled by youtube-dl-exec
// (installed via npm, so it always exists on hosts like Render without any
// extra build step); fall back to a system-wide "yt-dlp" on PATH.
let ytDlpPath = "yt-dlp";
try {
  const bundled = require("youtube-dl-exec").constants?.YOUTUBE_DL_PATH;
  if (bundled && fs.existsSync(bundled)) ytDlpPath = bundled;
} catch (e) {}

// â”€â”€â”€ PO Token Generator (bgutils-js + JSDOM, NO Chrome needed) â”€â”€â”€
let bgUtils = null;
let jsdomReady = false;
let cachedPoToken = null;
let cachedContentBinding = null;
let poTokenExpiry = 0;
let potProviderRunning = false;

async function setupJSDOM() {
  if (jsdomReady) return;
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: "https://www.youtube.com/" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
  });
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
  }
  jsdomReady = true;
  console.log("[POT] JSDOM initialized");
}

async function loadBgUtils() {
  if (bgUtils) return bgUtils;
  try {
    bgUtils = {
      botguard: await import("bgutils-js/botguard"),
      webpo: await import("bgutils-js/webpo"),
      utils: await import("bgutils-js/utils"),
    };
    console.log("[POT] bgutils-js loaded successfully");
  } catch (e) {
    console.log("[POT] ERROR loading bgutils-js:", e.message);
    throw e;
  }
  return bgUtils;
}

function fetchFn(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method, headers: options.headers || {} },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ ok: res.statusCode >= 200, status: res.statusCode, json: async () => JSON.parse(data), text: async () => data }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function generatePoToken(contentBinding) {
  // Return cached token if still valid
  if (cachedPoToken && Date.now() < poTokenExpiry && (!contentBinding || contentBinding === cachedContentBinding)) {
    return cachedPoToken;
  }

  const origWarn = console.warn;
  console.warn = () => {};

  try {
    console.log("[POT] Starting PO Token generation...");
    await setupJSDOM();
    const { botguard, webpo, utils } = await loadBgUtils();
    const { Innertube } = await import("youtubei.js");

    // 1. Get visitor data (content binding)
    if (!contentBinding) {
      console.log("[POT] Getting visitor data from Innertube...");
      const yt = await Innertube.create({ retrieve_player: false });
      contentBinding = yt.session.context.client.visitorData;
      console.log("[POT] Visitor data:", contentBinding?.substring(0, 20) + "...");
    }
    cachedContentBinding = contentBinding;

    // 2. Get BotGuard challenge from YouTube
    console.log("[POT] Requesting BotGuard challenge...");
    const attResp = await fetchFn("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
      method: "POST",
      headers: { ...utils.getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20260227.01.00" } },
        engagementType: "ENGAGEMENT_TYPE_UNBOUND",
      }),
    });
    const attestation = await attResp.json();
    const challenge = attestation.bgChallenge;
    if (!challenge) throw new Error("No bgChallenge in attestation response");
    console.log("[POT] Challenge received:", challenge.globalName);

    // 3. Fetch and execute interpreter JavaScript
    console.log("[POT] Fetching interpreter JS...");
    const interpreterUrl = challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    const interpResp = await fetchFn("https:" + interpreterUrl);
    const interpreterJS = await interpResp.text();
    console.log("[POT] Interpreter JS:", interpreterJS.length, "bytes");

    console.log("[POT] Executing interpreter...");
    new Function(interpreterJS)();

    // 4. Create BotGuardClient and take snapshot
    console.log("[POT] Creating BotGuardClient...");
    const bgClient = await botguard.BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: globalThis,
    });

    console.log("[POT] Taking BotGuard snapshot...");
    const webPoSignalOutput = [];
    const bgResponse = await bgClient.snapshot({ webPoSignalOutput });
    console.log("[POT] Snapshot complete");

    // 5. Get integrity token from YouTube
    console.log("[POT] Requesting integrity token...");
    const itResp = await fetchFn(utils.buildURL("GenerateIT"), {
      method: "POST",
      headers: utils.getHeaders(),
      body: JSON.stringify(["O43z0dpjhgX20SCx4KAo", bgResponse]),
    });
    const itData = await itResp.json();
    const [integrityToken, ttl, refreshThreshold, fallback] = itData;
    if (!integrityToken) throw new Error("Empty integrity token: " + JSON.stringify(itData));
    console.log("[POT] Integrity token received, TTL:", ttl, "s");

    // 6. Mint PO token
    console.log("[POT] Minting PO token...");
    const minter = await webpo.WebPoMinter.create(
      { integrityToken, estimatedTtlSecs: ttl, mintRefreshThreshold: refreshThreshold, websafeFallbackToken: fallback },
      webPoSignalOutput
    );
    const poToken = await minter.mintAsWebsafeString(contentBinding);
    console.warn = origWarn;

    if (!poToken) throw new Error("Empty PO token from minter");

    cachedPoToken = poToken;
    poTokenExpiry = Date.now() + Math.min(ttl - 300, 6 * 3600) * 1000;
    console.log("[POT] âœ“ SUCCESS! PO Token:", poToken.substring(0, 40) + "...");
    return poToken;
  } catch (e) {
    console.warn = origWarn;
    console.log("[POT] âœ— FAILED:", e.message);
    if (e.stack) console.log("[POT] Stack:", e.stack.split("\n").slice(0, 3).join("\n"));
    return null;
  }
}

// â”€â”€â”€ Mini PO Token Provider Server (port 4416) â”€â”€â”€
// The bgutil-ytdlp-pot-provider pip plugin auto-connects to this
function startPotProviderServer() {
  try {
    const potApp = express();
    potApp.use(express.json());

    potApp.get("/ping", (req, res) => {
      res.json({ server_uptime: process.uptime(), version: "1.0.0" });
    });

    potApp.post("/get_pot", async (req, res) => {
      try {
        const contentBinding = req.body?.content_binding;
        console.log("[POT] Provider received request, binding:", contentBinding?.substring(0, 20) || "none");
        const poToken = await generatePoToken(contentBinding);
        if (poToken) {
          res.json({
            poToken,
            contentBinding: contentBinding || cachedContentBinding,
            expiresAt: new Date(poTokenExpiry).toISOString(),
          });
        } else {
          res.status(500).json({ error: "Failed to generate PO token" });
        }
      } catch (e) {
        console.log("[POT] Provider error:", e.message);
        res.status(500).json({ error: e.message });
      }
    });

    potApp.post("/invalidate_caches", (req, res) => {
      cachedPoToken = null;
      poTokenExpiry = 0;
      res.status(204).send();
    });

    potApp.listen(4416, "127.0.0.1", () => {
      potProviderRunning = true;
      console.log("[POT] âœ“ Provider server running on port 4416");
    });
  } catch (e) {
    console.log("[POT] Provider server failed to start:", e.message);
  }
}

const app = express();

// ─── Security configuration ───
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const API_KEY = process.env.API_KEY || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Constant-time string comparison to avoid timing attacks on secret checks
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Require a valid API key for public data endpoints when API_KEY is configured.
// If API_KEY is unset the endpoints stay open (backward compatible) but a
// warning is logged at startup so the operator is aware.
function requireApiKey(req, res, next) {
  // If API_KEY is not set, skip authentication entirely
  if (!API_KEY) return next();
  
  // If API_KEY_REQUIRED is set to "false", skip authentication
  if (process.env.API_KEY_REQUIRED === "false") return next();
  
  const provided =
    req.get("x-api-key") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (safeEqual(provided, API_KEY)) return next();
  return res.status(401).json({ success: false, error: "Unauthorized" });
}

// Diagnostic endpoints are disabled unless ADMIN_TOKEN is set, and then require
// it. A 404 is returned otherwise so their existence is not advertised.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).send("Not found");
  const provided = req.get("x-admin-token") || req.query.token || "";
  if (safeEqual(String(provided), ADMIN_TOKEN)) return next();
  return res.status(404).send("Not found");
}

if (ALLOWED_ORIGINS.length > 0) {
  app.use(cors({ origin: ALLOWED_ORIGINS }));
} else {
  console.warn(
    "[SECURITY] ALLOWED_ORIGINS not set \u2014 CORS is open to all origins. " +
      "Set ALLOWED_ORIGINS (comma-separated) to restrict access."
  );
  app.use(cors());
}
app.use(express.json({ limit: "16kb" }));

// â”€â”€â”€ Spotify API â”€â”€â”€
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID || "",
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
});
let tokenExpiry = 0;
async function ensureSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET)
    throw new Error("Spotify credentials not configured");
  if (Date.now() < tokenExpiry) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  tokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

let cookieFilePath = null;
function getCookieFile() {
  if (cookieFilePath && fs.existsSync(cookieFilePath)) return cookieFilePath;
  if (process.env.YOUTUBE_COOKIE_FILE && fs.existsSync(process.env.YOUTUBE_COOKIE_FILE)) {
    cookieFilePath = process.env.YOUTUBE_COOKIE_FILE;
    return cookieFilePath;
  }
  if (process.env.YOUTUBE_COOKIES) {
    cookieFilePath = "/tmp/yt_cookies.txt";
    fs.writeFileSync(cookieFilePath, normalizeCookies(process.env.YOUTUBE_COOKIES));
    return cookieFilePath;
  }
  return null;
}

async function tryDownload(videoUrl, outputFile, controller = null) {
  const cookieFile = getCookieFile();
  const poToken = await generatePoToken();
  const results = [];
  
  // Helper to check cancellation
  const isCancelled = () => controller?.cancelled;

  if (!poToken) {
    console.log("[DL] âš  No PO Token available - downloads will likely fail");
  }
  
  // Helper to run yt-dlp with cancellation check
  async function runYtDlpWithCheck(args) {
    if (isCancelled()) return { ok: false, stderr: "cancelled", timedOut: false };
    return await runYtDlp(args, { ytDlpPath });
  }

  // Strategy 1: PO Token only (no cookies) â€” most reliable, bypasses bot detection
  // STOP on first clear failure (bot detection = immediate stop)
  if (poToken) {
    for (const client of [null, "android_vr", "web", "mweb"]) {
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      const extractorArgs = client
        ? `youtube:player_client=${client};po_token=gvs:${poToken}`
        : `youtube:po_token=gvs:${poToken}`;
      const args = buildYtDlpArgs({ outputFile, extractorArgs, ffmpegPath, videoUrl });

      const label = `${client || "default"}+pot`;
      console.log(`[DL] Trying ${label}...`);
      const result = await runYtDlpWithCheck(args);
      
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      if (result.ok && isValidDownload(outputFile)) {
        console.log(`[DL] âœ“ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
        return { ok: true, method: label, results };
      }
      const errLine = extractErrorLine(result.stderr, result.stderr.substring(0, 200));
      results.push({ method: label, error: errLine });
      console.log(`[DL] âœ— ${label}: ${errLine}`);
      safeUnlink(outputFile);
      
      // If it's a bot detection error, stop trying other strategies (they'll all fail)
      if (errLine && (errLine.includes("bot") || errLine.includes("detected") || errLine.includes("403") || errLine.includes("captcha"))) {
        console.log(`[DL] Bot detection detected - stopping retries`);
        return { ok: false, results, stopped: "bot_detection" };
      }
    }
  }

  // Strategy 2: Cookies + PO Token
  if (cookieFile && poToken && !isCancelled()) {
    for (const client of ["web", "mweb", "android"]) {
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      const args = buildYtDlpArgs({
        outputFile,
        extractorArgs: `youtube:player_client=${client};po_token=gvs:${poToken}`,
        cookieFile, ffmpegPath, videoUrl,
      });

      const label = `${client}+cookies+pot`;
      console.log(`[DL] Trying ${label}...`);
      const result = await runYtDlpWithCheck(args);
      
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      if (result.ok && isValidDownload(outputFile)) {
        console.log(`[DL] âœ“ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
        return { ok: true, method: label, results };
      }
      const errLine = extractErrorLine(result.stderr);
      results.push({ method: label, error: errLine });
      console.log(`[DL] âœ— ${label}: ${errLine}`);
      safeUnlink(outputFile);
      
      // If bot detection, stop
      if (errLine && (errLine.includes("bot") || errLine.includes("detected") || errLine.includes("403") || errLine.includes("captcha"))) {
        console.log(`[DL] Bot detection detected - stopping retries`);
        return { ok: false, results, stopped: "bot_detection" };
      }
    }
  }

  // Strategy 3: Cookies only (last resort) - only if not already stopped
  if (cookieFile && !isCancelled()) {
    for (const client of ["web", "android_vr"]) {
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      const args = buildYtDlpArgs({
        outputFile,
        extractorArgs: `youtube:player_client=${client}`,
        cookieFile, ffmpegPath, videoUrl,
      });
      const label = `${client}+cookies`;
      const result = await runYtDlpWithCheck(args);
      
      if (isCancelled()) return { ok: false, results, cancelled: true };
      
      if (result.ok && isValidDownload(outputFile))
        return { ok: true, method: label, results };
      results.push({ method: label, error: "failed" });
      safeUnlink(outputFile);
    }
  }
  
  if (isCancelled()) return { ok: false, results, cancelled: true };

  return { ok: false, results };
}

/**
 * Embed comprehensive ID3 metadata into an MP3 file.
 * Supports: title, artist, album, track number, year, genre, disc number, ISRC, comment, artwork
 */
function tagMp3(inputFile, outputFile, metadata, artworkPath) {
  return new Promise((resolve, reject) => {
    // First, use ffmpeg to embed basic metadata and artwork
    if (ffmpeg) {
      let cmd = ffmpeg().input(inputFile);
      if (artworkPath && fs.existsSync(artworkPath)) cmd = cmd.input(artworkPath);
      
      const opts = [
        "-metadata", `title=${metadata.title || ""}`,
        "-metadata", `artist=${metadata.artist || ""}`,
        "-metadata", `album=${metadata.album || ""}`,
        "-metadata", `track=${metadata.trackNumber || ""}`,
        "-metadata", `year=${metadata.year || ""}`,
        "-metadata", `genre=${metadata.genre || ""}`,
        "-metadata", `disc=${metadata.discNumber || ""}`,
        "-metadata", `comment=${metadata.comment || `Downloaded from Spotify via SideCut | ${metadata.spotifyId || ""}`}`,
      ];
      
      if (artworkPath && fs.existsSync(artworkPath)) {
        opts.push("-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
      }
      
      cmd.toFormat("mp3").audioBitrate(320).outputOptions(opts).save(outputFile)
        .on("end", () => {
          // Now enhance with node-id3 for additional tags
          try {
            const tags = {
              title: metadata.title,
              artist: metadata.artist,
              album: metadata.album,
              trackNumber: metadata.trackNumber ? String(metadata.trackNumber) : undefined,
              year: metadata.year,
              genre: metadata.genre,
              discNumber: metadata.discNumber ? String(metadata.discNumber) : undefined,
              comment: {
                language: "eng",
                text: metadata.comment || `Downloaded from Spotify via SideCut | ${metadata.spotifyId || ""}`
              },
              image: artworkPath && fs.existsSync(artworkPath) ? artworkPath : undefined,
              imageMimeType: "image/jpeg",
            };
            
            // Add ISRC if available (node-id3 specific)
            if (metadata.isrc) {
              tags.userDefinedFrame = {
                "TXXX:ISRC": metadata.isrc
              };
            }
            
            NodeID3.update(tags, outputFile, (err) => {
              if (err) console.log("[TAG] node-id3 warning:", err.message);
              resolve();
            });
          } catch (e) {
            console.log("[TAG] Enhancement failed:", e.message);
            resolve();
          }
        })
        .on("error", (e) => {
          console.log("[TAG] ffmpeg failed, using copy:", e.message);
          try { fs.copyFileSync(inputFile, outputFile); } catch (copyErr) {}
          resolve();
        });
    } else {
      // Fallback: just copy and use node-id3
      try {
        fs.copyFileSync(inputFile, outputFile);
        const tags = {
          title: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          trackNumber: metadata.trackNumber ? String(metadata.trackNumber) : undefined,
          year: metadata.year,
          genre: metadata.genre,
          comment: {
            language: "eng",
            text: `Downloaded from Spotify via SideCut | ${metadata.spotifyId || ""}`
          },
          image: artworkPath && fs.existsSync(artworkPath) ? artworkPath : undefined,
          imageMimeType: "image/jpeg",
        };
        NodeID3.update(tags, outputFile);
      } catch (e) {
        console.log("[TAG] Fallback failed:", e.message);
      }
      resolve();
    }
  });
}

// â”€â”€â”€ Routes â”€â”€â”€
app.get("/", (req, res) => res.send("SideCut backend is online!"));

app.get("/health", (req, res) => {
  const cookieAnalysis = analyzeCookieFile(getCookieFile());
  res.json({
    status: "ok",
    spotify: !!process.env.SPOTIFY_CLIENT_ID,
    cookies: !!getCookieFile(),
    cookie_valid: cookieAnalysis.isAuthenticated,
    cookie_age: lastCookieUpdate ? Date.now() - lastCookieUpdate : null,
    cookie_updates: cookieUpdateCount,
    proxy: !!process.env.YOUTUBE_PROXY,
    po_token: !!cachedPoToken,
    provider_running: potProviderRunning,
  });
});

// Admin endpoint: Update cookies manually
app.post("/admin/cookies/update", requireAdmin, async (req, res) => {
  const { cookies } = req.body;
  if (!cookies) {
    return res.status(400).json({ success: false, error: "No cookies provided" });
  }
  
  try {
    fs.writeFileSync("/tmp/yt_cookies.txt", normalizeCookies(cookies));
    cookieFilePath = "/tmp/yt_cookies.txt";
    lastCookieUpdate = Date.now();
    cookieUpdateCount++;
    
    const analysis = analyzeCookieFile(cookieFilePath);
    res.json({ 
      success: true, 
      message: "Cookies updated successfully",
      analysis 
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin endpoint: Get cookie status
app.get("/admin/cookies/status", requireAdmin, async (req, res) => {
  const cookieFile = getCookieFile();
  const analysis = analyzeCookieFile(cookieFile);
  
  res.json({
    configured: analysis.configured,
    valid: analysis.isAuthenticated,
    auth_cookies: analysis.authCookiesPresent,
    last_update: lastCookieUpdate ? new Date(lastCookieUpdate).toISOString() : null,
    update_count: cookieUpdateCount,
    auto_update_enabled: !!cookieAutoUpdateInterval,
    provider_configured: !!process.env.COOKIE_PROVIDER_URL,
  });
});

// Admin endpoint: Force cookie refresh
app.post("/admin/cookies/refresh", requireAdmin, async (req, res) => {
  try {
    const result = await checkAndRefreshCookies();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/debug", requireAdmin, async (req, res) => {
  let ytDlpVersion = null;
  try { ytDlpVersion = (await execFileAsync(ytDlpPath, ["--version"], { timeout: 5000 })).stdout.trim(); } catch (e) {}

  let pipPlugin = false;
  try {
    const r = await execFileAsync("pip3", ["show", "bgutil-ytdlp-pot-provider"], { timeout: 5000 });
    pipPlugin = r.stdout.includes("bgutil");
  } catch (e) {}

  // Check if bgutils-js is loadable
  let bgutilsAvailable = false;
  let bgutilsError = null;
  try {
    await import("bgutils-js/botguard");
    bgutilsAvailable = true;
  } catch (e) { bgutilsError = e.message; }

  // Check if jsdom is available
  let jsdomAvailable = false;
  try { require("jsdom"); jsdomAvailable = true; } catch (e) {}

  // Check if youtubei.js is available
  let youtubeiAvailable = false;
  try { await import("youtubei.js"); youtubeiAvailable = true; } catch (e) {}

  res.json({
    ffmpeg: !!ffmpeg,
    spotify: !!process.env.SPOTIFY_CLIENT_ID,
    cookies: getCookieFile() ? "configured" : "not configured",
    cookie_status: analyzeCookieFile(getCookieFile()),
    proxy_configured: !!process.env.YOUTUBE_PROXY,
    yt_dlp_version: ytDlpVersion,
    yt_dlp_path: ytDlpPath,
    has_po_token: !!cachedPoToken,
    pip_plugin_installed: pipPlugin,
    pot_provider_running: potProviderRunning,
    bgutils_available: bgutilsAvailable,
    bgutils_error: bgutilsError,
    jsdom_available: jsdomAvailable,
    youtubei_available: youtubeiAvailable,
    node_version: process.version,
    home: process.env.HOME,
  });
});

app.get("/test-pot", requireAdmin, async (req, res) => {
  console.log("=== /test-pot endpoint hit ===");
  const token = await generatePoToken();
  res.json({
    success: !!token,
    token: token ? token.substring(0, 40) + "..." : null,
    provider_running: potProviderRunning,
    cached: token === cachedPoToken,
  });
});

app.get("/test-download", requireAdmin, async (req, res) => {
  console.log("=== /test-download endpoint hit ===");
  const { ok, method, results } = await tryDownload(
    "https://www.youtube.com/watch?v=4NRXx6U8ABQ",
    "/tmp/sidecut_test.mp3"
  );
  try { if (fs.existsSync("/tmp/sidecut_test.mp3")) fs.unlinkSync("/tmp/sidecut_test.mp3"); } catch (e) {}
  res.json({ success: ok, winningMethod: method, results, hasPoToken: !!cachedPoToken });
});

app.post("/metadata", requireApiKey, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  try {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    const { type, id } = parsed;
    await ensureSpotifyToken();
    if (type === "track") {
      const d = (await spotifyApi.getTrack(id)).body;
      res.json({ success: true, type, id, title: d.name, artist: joinArtists(d.artists), album: d.album.name, artwork: firstImageUrl(d.album.images), duration: d.duration_ms, url });
    } else if (type === "album") {
      const d = (await spotifyApi.getAlbum(id)).body;
      const tracks = d.tracks.items.map((t) => ({ title: t.name, artist: joinArtists(t.artists), duration: t.duration_ms, trackNumber: t.track_number, spotifyUrl: t.external_urls?.spotify || "", spotifyId: t.id }));
      res.json({ success: true, type, id, title: d.name, artist: joinArtists(d.artists), album: d.name, artwork: firstImageUrl(d.images), trackCount: d.tracks.items.length, tracks, url });
    } else if (type === "playlist") {
      const d = (await spotifyApi.getPlaylist(id)).body;
      const tracks = d.tracks.items.filter((item) => item.track).map((item) => ({ title: item.track.name, artist: joinArtists(item.track.artists), album: item.track.album?.name || "", duration: item.track.duration_ms, spotifyUrl: item.track.external_urls?.spotify || "", spotifyId: item.track.id, artwork: firstImageUrl(item.track.album?.images) }));
      res.json({ success: true, type, id, title: d.name, artist: d.owner?.display_name || "Various Artists", album: d.name, artwork: firstImageUrl(d.images), trackCount: tracks.length, tracks, url });
    }
  } catch (error) {
    console.error("[/metadata] error:", error.message);
    res.status(500).json({ success: false, error: "Failed: " + error.message });
  }
});

// Look up the best-matching Spotify track metadata for a song that lacks it.
// `spec` is { query } or { title, artist }. Resolves to the mapped metadata,
// or a { found: false } result when nothing matches or the input is empty.
async function lookupMetadata(spec) {
  const q = buildSearchQuery(spec || {});
  if (!q) return { query: null, found: false, error: "No search terms provided", ...spec };
  const r = await spotifyApi.searchTracks(q, { limit: 1 });
  const track = r.body.tracks?.items?.[0];
  if (!track) return { query: q, found: false };
  return { query: q, found: true, ...mapTrackToMetadata(track) };
}

// Enrich songs missing metadata by searching Spotify. Accepts a single song
// ({ query } or { title, artist }) or a batch ({ items: [...] }, max 50) and
// returns the best-matching title/artist/album/artwork for each.
app.post("/search-metadata", requireApiKey, async (req, res) => {
  const { items, query, title, artist } = req.body || {};
  // Validate inputs before touching Spotify so bad requests fail fast.
  if (Array.isArray(items)) {
    if (items.length > 50)
      return res.status(400).json({ success: false, error: "Too many items (max 50)" });
  } else if (!buildSearchQuery({ query, title, artist })) {
    return res.status(400).json({ success: false, error: "Provide query, title, or items[]" });
  }
  try {
    await ensureSpotifyToken();
    if (Array.isArray(items)) {
      const results = await Promise.all(
        items.map((it) =>
          lookupMetadata(it).catch((e) => ({ query: buildSearchQuery(it || {}), found: false, error: e.message }))
        )
      );
      return res.json({ success: true, count: results.length, results });
    }
    const result = await lookupMetadata({ query, title, artist });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("[/search-metadata] error:", error.message);
    res.status(500).json({ success: false, error: "Failed: " + error.message });
  }
});

// Download progress tracking
const downloadProgress = {};
const downloadControllers = {}; // AbortController-like for cancellation

app.get("/download-status/:id", (req, res) => {
  const status = downloadProgress[req.params.id];
  if (!status) return res.status(404).json({ error: "Download not found" });
  
  const elapsed = (Date.now() - status.startTime) / 1000;
  let estimatedRemaining = null;
  
  if (status.totalBytes && status.downloadedBytes) {
    const progress = status.downloadedBytes / status.totalBytes;
    const speed = status.downloadedBytes / elapsed;
    if (speed > 0) {
      const remainingBytes = status.totalBytes - status.downloadedBytes;
      estimatedRemaining = remainingBytes / speed;
    }
    status.progress = Math.round(progress * 100);
  }
  
  res.json({
    trackId: req.params.id,
    trackName: status.trackName,
    stage: status.stage,
    progress: status.progress || 0,
    elapsedSeconds: Math.round(elapsed),
    estimatedRemainingSeconds: estimatedRemaining ? Math.round(estimatedRemaining) : null,
    error: status.error,
  });
});

// Cancel a download
app.post("/download-cancel/:id", (req, res) => {
  const id = req.params.id;
  if (downloadControllers[id]) {
    downloadControllers[id].cancelled = true;
    console.log(`[DL] Download ${id} cancellation requested`);
    res.json({ success: true, message: "Download cancellation requested" });
  } else if (downloadProgress[id]) {
    downloadProgress[id].stage = "cancelled";
    downloadProgress[id].error = "Cancelled by user";
    res.json({ success: true, message: "Download marked as cancelled" });
  } else {
    res.status(404).json({ error: "Download not found" });
  }
});

app.post("/download", requireApiKey, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  let artworkPath = null, rawFile = null, taggedFile = null;
  const tempFiles = [];
  try {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    const { type, id } = parsed;
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks supported." });

    console.log(`[/download] Starting download for track ID: ${id}`);
    
    await ensureSpotifyToken();
    console.log(`[/download] Spotify token ready`);
    
    const track = (await spotifyApi.getTrack(id)).body;
    const artistName = joinArtists(track.artists);
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = firstImageUrl(track.album.images);
    const releaseYear = track.album.release_date ? track.album.release_date.split("-")[0] : "";
    console.log(`[/download] Track: ${artistName} - ${trackName}`);
    
    // Extract genre from album (if available) - Spotify doesn't always provide this
    const genre = track.genres?.[0] || "Music";
    
    // Build comprehensive metadata object
    const metadata = {
      title: trackName,
      artist: artistName,
      album: albumName,
      trackNumber: track.track_number,
      discNumber: track.disc_number,
      year: releaseYear,
      genre: genre,
      isrc: track.external_ids?.isrc || "",
      spotifyId: track.id,
      comment: `Source: Spotify | ${track.external_urls?.spotify || ""}`,
      duration: track.duration_ms,
    };

    console.log(`[/download] Searching YouTube for: ${artistName} ${trackName}`);
    downloadProgress[id] = { startTime: Date.now(), trackName: `${artistName} - ${trackName}`, stage: "searching", progress: 0 };
    downloadControllers[id] = { cancelled: false };
    
    const searchResults = await ytSearch(`${artistName} ${trackName}`);
    console.log(`[/download] YouTube search complete, found ${searchResults.videos?.length || 0} videos`);
    
    const video = searchResults.videos[0];
    if (!video) {
      delete downloadProgress[id];
      delete downloadControllers[id];
      return res.status(404).json({ success: false, error: "No matching audio on YouTube" });
    }
    console.log(`[/download] Found video: ${video.title}`);

    // Check for cancellation
    if (downloadControllers[id]?.cancelled) {
      console.log(`[/download] Download cancelled before starting`);
      delete downloadProgress[id];
      delete downloadControllers[id];
      return res.status(499).json({ success: false, error: "Download cancelled" });
    }

    // Estimate file size based on duration (audio ~128kbps = ~16KB/s)
    const estimatedDurationSec = video.duration?.seconds || track.duration_ms / 1000 || 180;
    const estimatedSizeBytes = estimatedDurationSec * 16000;
    downloadProgress[id].stage = "downloading";
    downloadProgress[id].totalBytes = estimatedSizeBytes;
    downloadProgress[id].downloadedBytes = 0;

    if (artworkUrl) {
      try { artworkPath = `/tmp/artwork_${id}.jpg`; await downloadFile(artworkUrl, artworkPath); console.log(`[/download] Artwork downloaded`); } catch (e) { console.log(`[/download] Artwork download failed: ${e.message}`); }
    }

    rawFile = `/tmp/sidecut_raw_${id}_${Date.now()}.mp3`;
    tempFiles.push(rawFile);
    console.log(`[/download] Starting YouTube download...`);

    const controller = downloadControllers[id];
    const { ok, method, results } = await tryDownload(video.url, rawFile, controller);
    console.log(`[/download] YouTube download complete, ok=${ok}, cancelled=${controller?.cancelled}`);
    
    // Check if cancelled during download
    if (controller?.cancelled) {
      console.log(`[/download] Download was cancelled`);
      downloadProgress[id].stage = "cancelled";
      delete downloadProgress[id];
      delete downloadControllers[id];
      return res.status(499).json({ success: false, error: "Download cancelled" });
    }
    
    if (!ok) {
      console.log(`[/download] Download failed: ${JSON.stringify(results)}`);
      downloadProgress[id].stage = "failed";
      downloadProgress[id].error = (results || []).map((r) => `[${r.method}]: ${r.error}`).join(" | ");
      const errorResponse = {
        success: false,
        error: downloadProgress[id].error,
        video: { title: video.title, url: video.url },
        hasPoToken: !!cachedPoToken,
        hasProxy: !!process.env.YOUTUBE_PROXY,
        hasCookies: !!getCookieFile(),
      };
      delete downloadProgress[id];
      delete downloadControllers[id];
      return res.status(502).json(errorResponse);
    }
    
    // Check actual file size
    if (fs.existsSync(rawFile)) {
      downloadProgress[id].downloadedBytes = fs.statSync(rawFile).size;
      downloadProgress[id].progress = 100;
    }
    downloadProgress[id].stage = "processing";
    console.log(`[/download] Processing tags...`);

    taggedFile = `/tmp/sidecut_tagged_${id}_${Date.now()}.mp3`;
    tempFiles.push(taggedFile);
    try { await tagMp3(rawFile, taggedFile, metadata, artworkPath); }
    catch (e) { fs.copyFileSync(rawFile, taggedFile); }

    const safeFileName = `${artistName} - ${trackName}`.replace(/[^\w\s\-]/g, "_").trim();
    downloadProgress[id].stage = "streaming";
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.mp3"`);
    const fileStream = fs.createReadStream(taggedFile);
    fileStream.pipe(res);
    fileStream.on("end", () => {
      cleanup();
      delete downloadProgress[id];
      delete downloadControllers[id];
    });
    fileStream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ success: false, error: "Stream error" });
      cleanup();
      delete downloadProgress[id];
      delete downloadControllers[id];
    });
    req.on("close", () => {
      cleanup();
      delete downloadProgress[id];
      delete downloadControllers[id];
    });
  } catch (error) {
    console.error("[/download] error:", error.message);
    downloadProgress[id] = { stage: "failed", error: error.message };
    cleanup();
    delete downloadProgress[id];
    delete downloadControllers[id];
    if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed: " + error.message });
  }
  function cleanup() {
    [artworkPath, ...tempFiles].forEach((f) => safeUnlink(f));
  }
});

// Batch download endpoint - downloads a track and returns base64 encoded MP3
// Useful for playlist downloads where client handles individual files
app.post("/download-batch", requireApiKey, async (req, res) => {
  const { tracks } = req.body;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ success: false, error: "No tracks provided" });
  }
  if (tracks.length > 50) {
    return res.status(400).json({ success: false, error: "Max 50 tracks per batch" });
  }

  const results = [];
  for (const trackInfo of tracks) {
    const { spotifyUrl, title, artist, album, artwork, trackNumber, spotifyId, releaseDate } = trackInfo;
    let artworkPath = null, rawFile = null, taggedFile = null;
    const tempFiles = [];
    
    try {
      // Search YouTube
      const searchQuery = `${artist || ""} ${title || ""}`.trim();
      if (!searchQuery) {
        results.push({ spotifyId, success: false, error: "No search query" });
        continue;
      }
      
      const searchResults = await ytSearch(searchQuery);
      const video = searchResults.videos?.[0];
      if (!video) {
        results.push({ spotifyId, success: false, error: "No YouTube match found" });
        continue;
      }

      // Download artwork if available
      if (artwork) {
        try {
          artworkPath = `/tmp/artwork_${spotifyId || Date.now()}.jpg`;
          await downloadFile(artwork, artworkPath);
          tempFiles.push(artworkPath);
        } catch (e) { /* skip artwork */ }
      }

      // Build metadata
      const metadata = {
        title: title || "Unknown",
        artist: artist || "Unknown Artist",
        album: album || "Unknown Album",
        trackNumber: trackNumber || undefined,
        year: releaseDate ? releaseDate.split("-")[0] : undefined,
        spotifyId: spotifyId || "",
        comment: `Source: Spotify | ${spotifyUrl || ""}`,
      };

      // Download audio
      rawFile = `/tmp/sidecut_raw_${spotifyId || Date.now()}_${Date.now()}.mp3`;
      tempFiles.push(rawFile);
      
      const downloadResult = await tryDownload(video.url, rawFile);
      if (!downloadResult.ok) {
        const errorMsg = downloadResult.results?.map((r) => r.error).join(", ") || "Download failed";
        results.push({ spotifyId, success: false, error: errorMsg, video: video.title });
        tempFiles.forEach(f => safeUnlink(f));
        continue;
      }

      // Tag and return
      taggedFile = `/tmp/sidecut_tagged_${spotifyId || Date.now()}_${Date.now()}.mp3`;
      tempFiles.push(taggedFile);
      
      try { await tagMp3(rawFile, taggedFile, metadata, artworkPath); }
      catch (e) { fs.copyFileSync(rawFile, taggedFile); }

      const fileBuffer = fs.readFileSync(taggedFile);
      results.push({
        spotifyId,
        success: true,
        filename: `${(artist || "Unknown").replace(/[^\w\s\-]/g, "_")} - ${(title || "Unknown").replace(/[^\w\s\-]/g, "_")}.mp3`,
        data: fileBuffer.toString("base64"),
        method: downloadResult.method,
      });
      
    } catch (error) {
      console.error(`[/download-batch] Track ${spotifyId} error:`, error.message);
      results.push({ spotifyId, success: false, error: error.message });
    } finally {
      tempFiles.forEach(f => safeUnlink(f));
    }
  }

  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;

function start() {
  return app.listen(PORT, async () => {
    console.log(`SideCut backend running on port ${PORT}`);
    console.log(`Node: ${process.version}`);
    if (!API_KEY) {
      console.warn(
        "[SECURITY] API_KEY not set \u2014 /metadata and /download are unauthenticated. " +
          "Set API_KEY to require an x-api-key header."
      );
    }
    if (!ADMIN_TOKEN) {
      console.warn(
        "[SECURITY] ADMIN_TOKEN not set \u2014 /debug, /test-pot and /test-download are disabled."
      );
    }

    // Start the PO Token provider server (for pip plugin auto-connect)
    startPotProviderServer();

    // Start auto cookie update if configured
    if (process.env.COOKIE_PROVIDER_URL || process.env.YOUTUBE_COOKIES) {
      const intervalMs = parseInt(process.env.COOKIE_UPDATE_INTERVAL || "1800000"); // Default 30 min
      startCookieAutoUpdate(intervalMs);
    }

    // Pre-generate PO Token at startup so errors are visible in Render logs
    console.log("=== Pre-generating PO Token at startup ===");
    const token = await generatePoToken();
    if (token) {
      console.log("âœ“âœ“âœ“ PO Token ready at startup âœ“âœ“âœ“");
    } else {
      console.log("âš âš âš  PO Token generation FAILED at startup âš âš âš ");
      console.log("âš  Check the [POT] error messages above");
    }
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  app,
  start,
  parseSpotifyUrl,
  getCookieFile,
  normalizeCookies,
  analyzeCookieFile,
  downloadFile,
  tagMp3,
  fetchFn,
  runYtDlp,
  ensureSpotifyToken,
  generatePoToken,
  startPotProviderServer,
};
