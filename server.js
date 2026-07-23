const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");

let youtubedl = null;
try { youtubedl = require("youtube-dl-exec"); } catch (e) {}
let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegPath = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {}

// ─── PO Token Generator ───
let bgUtils = null;
let jsdomReady = false;
let cachedPoToken = null;
let poTokenExpiry = 0;

async function setupJSDOM() {
  if (jsdomReady) return;
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: "https://www.youtube.com/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location });
  if (!globalThis.navigator) Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
  jsdomReady = true;
}

async function loadBgUtils() {
  if (bgUtils) return bgUtils;
  bgUtils = {
    botguard: await import("bgutils-js/botguard"),
    webpo: await import("bgutils-js/webpo"),
    utils: await import("bgutils-js/utils"),
  };
  return bgUtils;
}

function fetchFn(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, method, headers: options.headers || {} }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ ok: res.statusCode >= 200, json: async () => JSON.parse(data), text: async () => data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function generatePoToken() {
  if (cachedPoToken && Date.now() < poTokenExpiry) return cachedPoToken;
  
  try {
    console.log("Generating PO Token...");
    await setupJSDOM();
    const { botguard, webpo, utils } = await loadBgUtils();
    const { Innertube } = require("youtubei.js");
    const origWarn = console.warn;
    console.warn = () => {};

    // 1. Get visitor data
    const yt = await Innertube.create({ retrieve_player: false });
    const contentBinding = yt.session.context.client.visitorData;

    // 2. Get BotGuard challenge
    const attResp = await fetchFn("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
      method: "POST",
      headers: { ...utils.getHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20260227.01.00" } }, engagementType: "ENGAGEMENT_TYPE_UNBOUND" }),
    });
    const challenge = (await attResp.json()).bgChallenge;

    // 3. Execute interpreter
    const interpResp = await fetchFn("https:" + challenge.interpreterUrl.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue);
    new Function(await interpResp.text())();

    // 4. BotGuard snapshot
    const bgClient = await botguard.BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
    const webPoSignalOutput = [];
    const bgResponse = await bgClient.snapshot({ webPoSignalOutput });

    // 5. Get integrity token
    const itResp = await fetchFn(utils.buildURL("GenerateIT"), {
      method: "POST", headers: utils.getHeaders(),
      body: JSON.stringify(["O43z0dpjhgX20SCx4KAo", bgResponse]),
    });
    const [integrityToken, ttl, refreshThreshold, fallback] = await itResp.json();
    if (!integrityToken) throw new Error("Empty integrity token");

    // 6. Mint PO token
    const minter = await webpo.WebPoMinter.create({ integrityToken, estimatedTtlSecs: ttl, mintRefreshThreshold: refreshThreshold, websafeFallbackToken: fallback }, webPoSignalOutput);
    const poToken = await minter.mintAsWebsafeString(contentBinding);
    
    console.warn = origWarn;
    if (!poToken) throw new Error("Empty PO token");
    console.log(`✓ PO Token generated (TTL: ${ttl}s): ${poToken.substring(0, 30)}...`);
    
    cachedPoToken = poToken;
    poTokenExpiry = Date.now() + Math.min(ttl - 300, 6 * 3600) * 1000;
    return poToken;
  } catch (e) {
    console.warn = origWarn || console.warn;
    console.log("✗ PO Token failed:", e.message);
    return null;
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// ─── Spotify API ───
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID || "",
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
});
let tokenExpiry = 0;
async function ensureSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) throw new Error("Spotify credentials not configured");
  if (Date.now() < tokenExpiry) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  tokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); fs.unlink(dest, () => {}); downloadFile(res.headers.location, dest).then(resolve).catch(reject); return; }
      res.pipe(file); file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}

let cookieFilePath = null;
function getCookieFile() {
  if (cookieFilePath && fs.existsSync(cookieFilePath)) return cookieFilePath;
  if (process.env.YOUTUBE_COOKIE_FILE && fs.existsSync(process.env.YOUTUBE_COOKIE_FILE)) { cookieFilePath = process.env.YOUTUBE_COOKIE_FILE; return cookieFilePath; }
  if (process.env.YOUTUBE_COOKIES) { cookieFilePath = "/tmp/yt_cookies.txt"; fs.writeFileSync(cookieFilePath, process.env.YOUTUBE_COOKIES); return cookieFilePath; }
  return null;
}

// ─── Run yt-dlp ───
async function runYtDlp(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile("yt-dlp", args, { timeout, maxBuffer: 1024 * 1024 * 50, cwd: "/tmp" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
    });
  });
}

// ─── Download audio ───
async function tryDownload(videoUrl, outputFile) {
  const cookieFile = getCookieFile();
  const poToken = await generatePoToken();
  const results = [];

  // Build extractor-args with PO token
  const poTokenArg = poToken ? `;po_token=gvs:${poToken}` : "";

  const attempts = [];
  // With cookies + PO token (different clients)
  if (cookieFile && poToken) {
    attempts.push({ client: "web", cookies: true, pot: true });
    attempts.push({ client: "mweb", cookies: true, pot: true });
    attempts.push({ client: "android", cookies: true, pot: true });
  }
  // PO token only (no cookies)
  if (poToken) {
    attempts.push({ client: null, cookies: false, pot: true });
    attempts.push({ client: "android_vr", cookies: false, pot: true });
  }
  // Cookies only (no PO token - fallback)
  if (cookieFile) {
    attempts.push({ client: "web", cookies: true, pot: false });
  }
  // Last resort: no cookies, no PO token
  attempts.push({ client: "android_vr", cookies: false, pot: false });

  for (const a of attempts) {
    let extractorArgs = "";
    if (a.client) extractorArgs += `youtube:player_client=${a.client}`;
    if (a.pot && poToken) extractorArgs += (a.client ? ";" : "youtube:") + `po_token=gvs:${poToken}`;
    if (!a.client && !a.pot) extractorArgs = "";

    const args = ["-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates"];
    if (extractorArgs) args.push("--extractor-args", extractorArgs);
    if (a.cookies && cookieFile) args.push("--cookies", cookieFile);
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);

    const label = `${a.client || "default"}${a.cookies ? "+cookies" : ""}${a.pot ? "+pot" : ""}`;
    console.log(`Trying ${label}...`);
    const result = await runYtDlp(args);

    if (result.ok && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: label, results };
    }
    const errorLine = result.stderr.split("\n").find(l => l.includes("ERROR")) || result.stderr.substring(0, 300);
    results.push({ method: label, error: errorLine });
    console.log(`✗ ${label}: ${errorLine}`);
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch(e) {}
  }

  return { ok: false, results };
}

// ─── Tag MP3 ───
function tagMp3(inputFile, outputFile, metadata, artworkPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { fs.copyFileSync(inputFile, outputFile); resolve(); return; }
    let cmd = ffmpeg().input(inputFile);
    if (artworkPath && fs.existsSync(artworkPath)) cmd = cmd.input(artworkPath);
    const opts = ["-metadata", `title=${metadata.title}`, "-metadata", `artist=${metadata.artist}`, "-metadata", `album=${metadata.album}`];
    if (artworkPath && fs.existsSync(artworkPath)) opts.push("-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
    cmd.toFormat("mp3").audioBitrate(192).outputOptions(opts).save(outputFile).on("end", resolve).on("error", reject);
  });
}

// ─── Routes ───
app.get("/", (req, res) => { res.send("SideCut backend is online!"); });
app.get("/health", (req, res) => { res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID, cookies: !!getCookieFile() }); });

app.get("/debug", async (req, res) => {
  let ytDlpVersion = null;
  try { ytDlpVersion = (await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 })).stdout.trim(); } catch(e) {}
  res.json({
    youtube_dl_exec: !!youtubedl, ffmpeg: !!ffmpeg, spotify: !!process.env.SPOTIFY_CLIENT_ID,
    cookies: getCookieFile() ? "configured" : "not configured",
    yt_dlp_version: ytDlpVersion, has_po_token: !!cachedPoToken,
    node_version: process.version,
  });
});

app.get("/test-pot", async (req, res) => {
  const token = await generatePoToken();
  res.json({ success: !!token, token: token ? token.substring(0, 40) + "..." : null });
});

app.get("/test-download", async (req, res) => {
  const { ok, method, results } = await tryDownload("https://www.youtube.com/watch?v=4NRXx6U8ABQ", "/tmp/sidecut_test.mp3");
  try { if (fs.existsSync("/tmp/sidecut_test.mp3")) fs.unlinkSync("/tmp/sidecut_test.mp3"); } catch(e) {}
  res.json({ success: ok, winningMethod: method, results });
});

app.post("/metadata", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  try {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    const type = match[1], id = match[2];
    await ensureSpotifyToken();
    if (type === "track") {
      const d = (await spotifyApi.getTrack(id)).body;
      res.json({ success: true, type, id, title: d.name, artist: d.artists.map((a) => a.name).join(", "), album: d.album.name, artwork: d.album.images[0]?.url || "", duration: d.duration_ms, url });
    } else if (type === "album") {
      const d = (await spotifyApi.getAlbum(id)).body;
      const tracks = d.tracks.items.map(t => ({ title: t.name, artist: t.artists.map(a => a.name).join(", "), duration: t.duration_ms, trackNumber: t.track_number, spotifyUrl: t.external_urls?.spotify || "", spotifyId: t.id }));
      res.json({ success: true, type, id, title: d.name, artist: d.artists.map((a) => a.name).join(", "), album: d.name, artwork: d.images[0]?.url || "", trackCount: d.tracks.items.length, tracks, url });
    } else if (type === "playlist") {
      const d = (await spotifyApi.getPlaylist(id)).body;
      const tracks = d.tracks.items.filter(item => item.track).map(item => ({ title: item.track.name, artist: item.track.artists.map(a => a.name).join(", "), album: item.track.album?.name || "", duration: item.track.duration_ms, spotifyUrl: item.track.external_urls?.spotify || "", spotifyId: item.track.id, artwork: item.track.album?.images?.[0]?.url || "" }));
      res.json({ success: true, type, id, title: d.name, artist: d.owner?.display_name || "Various Artists", album: d.name, artwork: d.images[0]?.url || "", trackCount: tracks.length, tracks, url });
    }
  } catch (error) { res.status(500).json({ success: false, error: "Failed: " + error.message }); }
});

app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  let artworkPath = null, rawFile = null, taggedFile = null;
  const tempFiles = [];
  try {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    const type = match[1], id = match[2];
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks supported." });

    await ensureSpotifyToken();
    const track = (await spotifyApi.getTrack(id)).body;
    const artistName = track.artists.map((a) => a.name).join(", ");
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = track.album.images[0]?.url || "";

    const searchResults = await ytSearch(`${artistName} ${trackName}`);
    const video = searchResults.videos[0];
    if (!video) return res.status(404).json({ success: false, error: "No matching audio on YouTube" });

    if (artworkUrl) { try { artworkPath = `/tmp/artwork_${id}.jpg`; await downloadFile(artworkUrl, artworkPath); } catch (e) {} }

    rawFile = `/tmp/sidecut_raw_${id}_${Date.now()}.mp3`;
    tempFiles.push(rawFile);

    const { ok, method, results } = await tryDownload(video.url, rawFile);
    if (!ok) {
      return res.status(502).json({
        success: false,
        error: (results || []).map(r => `[${r.method}]: ${r.error}`).join(" | "),
        video: { title: video.title, url: video.url },
      });
    }

    taggedFile = `/tmp/sidecut_tagged_${id}_${Date.now()}.mp3`;
    tempFiles.push(taggedFile);
    try { await tagMp3(rawFile, taggedFile, { title: trackName, artist: artistName, album: albumName }, artworkPath); }
    catch (e) { fs.copyFileSync(rawFile, taggedFile); }

    const safeFileName = `${artistName} - ${trackName}`.replace(/[^\w\s\-]/g, "_").trim();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.mp3"`);
    const fileStream = fs.createReadStream(taggedFile);
    fileStream.pipe(res);
    fileStream.on("end", () => cleanup());
    fileStream.on("error", () => { if (!res.headersSent) res.status(500).json({ success: false, error: "Stream error" }); cleanup(); });
    req.on("close", () => cleanup());
  } catch (error) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed: " + error.message });
  }
  function cleanup() { [artworkPath, ...tempFiles].forEach((f) => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideCut backend running on port ${PORT}`));
