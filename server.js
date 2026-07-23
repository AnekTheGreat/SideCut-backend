const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
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

// ─── Cookies ───
let cookieFilePath = null;
function getCookieFile() {
  if (cookieFilePath && fs.existsSync(cookieFilePath)) return cookieFilePath;
  if (process.env.YOUTUBE_COOKIE_FILE && fs.existsSync(process.env.YOUTUBE_COOKIE_FILE)) {
    cookieFilePath = process.env.YOUTUBE_COOKIE_FILE; return cookieFilePath;
  }
  if (process.env.YOUTUBE_COOKIES) {
    cookieFilePath = "/tmp/yt_cookies.txt";
    fs.writeFileSync(cookieFilePath, process.env.YOUTUBE_COOKIES);
    return cookieFilePath;
  }
  return null;
}

// ─── Find Chrome for the PO Token provider ───
function findChromePath() {
  // Check env var
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  // Puppeteer's Chrome
  try {
    const puppeteer = require("puppeteer");
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  // Puppeteer cache
  const home = process.env.HOME || "/root";
  const cacheDir = path.join(home, ".cache", "puppeteer", "chrome");
  try {
    if (fs.existsSync(cacheDir)) {
      const versions = fs.readdirSync(cacheDir);
      for (const v of versions) {
        const chromePath = path.join(cacheDir, v, "chrome-linux64", "chrome");
        if (fs.existsSync(chromePath)) return chromePath;
      }
    }
  } catch (e) {}
  // System
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── PO Token Provider (bgutil HTTP server) ───
let potProviderReady = false;

async function checkPotProvider() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:4416/ping", (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function startPotProvider() {
  if (await checkPotProvider()) {
    console.log("✓ PO Token provider already running");
    potProviderReady = true;
    return true;
  }

  // Find the provider server
  const home = process.env.HOME || "/root";
  const providerDir = path.join(home, "bgutil-ytdlp-pot-provider", "server");
  const serverJs = path.join(providerDir, "build", "main.js");
  
  if (!fs.existsSync(serverJs)) {
    console.log("⚠ bgutil provider not found at", serverJs);
    return false;
  }

  const chrome = findChromePath();
  console.log(`Starting PO Token provider... Chrome: ${chrome || "not found"}`);
  
  const env = { ...process.env };
  if (chrome) env.CHROME_PATH = chrome;

  try {
    const provider = spawn("node", [serverJs], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: false, cwd: providerDir,
    });
    provider.stdout.on("data", (d) => console.log(`  [POT] ${d.toString().trim()}`));
    provider.stderr.on("data", (d) => console.log(`  [POT] ${d.toString().trim()}`));
    provider.on("error", (e) => console.log(`  [POT] Start failed: ${e.message}`));
    provider.on("exit", (code) => console.log(`  [POT] Exited: ${code}`));

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (await checkPotProvider()) {
        console.log("✓ PO Token provider ready");
        potProviderReady = true;
        return true;
      }
    }
    console.log("⚠ PO Token provider didn't start in time");
    return false;
  } catch (e) {
    console.log("⚠ PO Token provider error:", e.message);
    return false;
  }
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
  const results = [];

  // With cookies + PO tokens (from bgutil plugin)
  const clients = ["web", "mweb", "android", "tv", "android_vr"];
  
  if (cookieFile) {
    for (const client of clients) {
      const args = ["-x", "--audio-format", "mp3", "--audio-quality", "5",
        "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates",
        "--extractor-args", `youtube:player_client=${client}`,
        "--cookies", cookieFile];
      if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
      args.push(videoUrl);

      const label = `${client}+cookies${potProviderReady ? "+pot" : ""}`;
      console.log(`Trying ${label}...`);
      const result = await runYtDlp(args);

      if (result.ok && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        console.log(`✓ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
        return { ok: true, method: label, results };
      }
      const errorLine = result.stderr.split("\n").find(l => l.includes("ERROR")) || result.stderr.substring(0, 300);
      results.push({ method: label, error: errorLine });
      try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch(e) {}
    }
  }

  // Without cookies
  for (const client of ["android_vr"]) {
    const args = ["-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates",
      "--extractor-args", `youtube:player_client=${client}`];
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    const label = `${client}${potProviderReady ? "+pot" : ""}`;
    const result = await runYtDlp(args);
    if (result.ok && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) return { ok: true, method: label, results };
    results.push({ method: label, error: result.stderr.split("\n").find(l => l.includes("ERROR")) || "failed" });
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

app.get("/health", (req, res) => {
  res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID, cookies: !!getCookieFile(), pot_provider: potProviderReady });
});

app.get("/debug", async (req, res) => {
  let ytDlpVersion = null;
  try { ytDlpVersion = (await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 })).stdout.trim(); } catch(e) {}
  
  // Check if bgutil pip plugin is installed
  let bgutilPlugin = false;
  try { const r = await execFileAsync("pip3", ["show", "bgutil-ytdlp-pot-provider"], { timeout: 5000 }); bgutilPlugin = r.stdout.includes("bgutil"); } catch(e) {}
  
  // Check if provider server is built
  const home = process.env.HOME || "/root";
  const providerServer = path.join(home, "bgutil-ytdlp-pot-provider", "server", "build", "main.js");
  const providerBuilt = fs.existsSync(providerServer);
  
  // Check yt-dlp verbose output for PO Token providers
  let potProviders = null;
  try {
    const r = await runYtDlp(["--list-extractors", "--print", "%P"], 5000);
    potProviders = r.stdout.substring(0, 500);
  } catch(e) {}

  res.json({
    youtube_dl_exec: !!youtubedl, ffmpeg: !!ffmpeg, ffmpeg_path: ffmpegPath,
    spotify: !!process.env.SPOTIFY_CLIENT_ID, cookies: getCookieFile() ? "configured" : "not configured",
    yt_dlp_version: ytDlpVersion,
    pot_provider_running: potProviderReady,
    bgutil_plugin_installed: bgutilPlugin,
    bgutil_provider_built: providerBuilt,
    provider_path: providerServer,
    chrome_path: findChromePath(),
    node_version: process.version, platform: process.platform, home: home,
  });
});

app.get("/test-download", async (req, res) => {
  if (!potProviderReady) await startPotProvider();
  const { ok, method, results } = await tryDownload("https://www.youtube.com/watch?v=4NRXx6U8ABQ", "/tmp/sidecut_test.mp3");
  try { if (fs.existsSync("/tmp/sidecut_test.mp3")) fs.unlinkSync("/tmp/sidecut_test.mp3"); } catch(e) {}
  res.json({ success: ok, winningMethod: method, results, potProvider: potProviderReady });
});

app.get("/diag", async (req, res) => {
  const cookieFile = getCookieFile();
  const args = ["--list-formats", "--no-playlist", "--no-warnings", "--extractor-args", "youtube:player_client=web"];
  if (cookieFile) args.push("--cookies", cookieFile);
  args.push("https://www.youtube.com/watch?v=4NRXx6U8ABQ");
  const result = await runYtDlp(args, 60000);
  res.json({ pot_provider: potProviderReady, cookies: !!cookieFile, format_list: (result.stderr + "\n" + result.stdout).trim().substring(0, 5000) });
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

    if (!potProviderReady) await startPotProvider();

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
        potProvider: potProviderReady,
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
app.listen(PORT, async () => {
  console.log(`SideCut backend running on port ${PORT}`);
  await startPotProvider();
});
