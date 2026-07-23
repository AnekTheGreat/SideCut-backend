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
try { youtubedl = require("youtube-dl-exec"); console.log("✓ youtube-dl-exec loaded"); } catch (e) {}
let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegPath = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("✓ ffmpeg-static loaded");
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
    cookieFilePath = process.env.YOUTUBE_COOKIE_FILE;
    return cookieFilePath;
  }
  if (process.env.YOUTUBE_COOKIES) {
    cookieFilePath = "/tmp/yt_cookies.txt";
    fs.writeFileSync(cookieFilePath, process.env.YOUTUBE_COOKIES);
    return cookieFilePath;
  }
  return null;
}

// ─── Download with system yt-dlp ───
// Tries different YouTube client + cookie combinations.
// Key insight from yt-dlp PO Token docs:
//   - android, ios, tv: PO Token NOT needed. Formats NOT DRM'd when cookies are passed.
//   - web, mweb: PO Token needed (GVS). Cookies provide auth but not PO token → "format not available"
//   - android_vr: PO Token not needed, but doesn't use cookies → bot detection from cloud IPs
async function downloadWithSystemYtDlp(videoUrl, outputFile, client, useCookies) {
  try {
    const args = [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile,
      "--no-playlist", "--no-warnings", "--no-check-certificates",
    ];
    if (client) {
      args.push("--extractor-args", `youtube:player_client=${client}`);
    }
    if (useCookies) {
      const cookieFile = getCookieFile();
      if (cookieFile) { args.push("--cookies", cookieFile); }
      else { useCookies = false; }
    }
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);

    const label = `yt-dlp[${client || "default"}${useCookies ? "+cookies" : ""}]`;
    console.log(`Running ${label}`);
    await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });

    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: label };
    }
    return { ok: false, method: label, error: "File too small or missing" };
  } catch (e) {
    const msg = String(e.message || e).substring(0, 300);
    console.log(`✗ yt-dlp[${client || "default"}${useCookies ? "+cookies" : ""}] failed: ${msg}`);
    return { ok: false, method: `yt-dlp[${client || "default"}${useCookies ? "+cookies" : ""}]`, error: msg };
  }
}

// ─── Download with npm youtube-dl-exec ───
async function downloadWithNpmYtDlp(videoUrl, outputFile, client, useCookies) {
  if (!youtubedl) return { ok: false, method: "npm-yt-dlp", error: "package not loaded" };
  try {
    const opts = {
      extractAudio: true, audioFormat: "mp3", audioQuality: 5,
      output: outputFile, noPlaylist: true, noWarnings: true,
    };
    if (client) opts.extractorArgs = `youtube:player_client=${client}`;
    if (useCookies) {
      const cookieFile = getCookieFile();
      if (cookieFile) opts.cookies = cookieFile;
      else useCookies = false;
    }
    if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
    await youtubedl(videoUrl, opts);

    const label = `npm[${client || "default"}${useCookies ? "+cookies" : ""}]`;
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: label };
    }
    return { ok: false, method: label, error: "File too small or missing" };
  } catch (e) {
    const msg = String(e.message || e).substring(0, 300);
    console.log(`✗ npm-yt-dlp failed: ${msg}`);
    return { ok: false, method: `npm[${client || "default"}${useCookies ? "+cookies" : ""}]`, error: msg };
  }
}

// ─── Try all download methods ───
async function tryAllDownloads(videoUrl, outputFile) {
  const hasCookies = !!getCookieFile();
  const results = [];

  // Priority order based on yt-dlp PO Token docs:
  // 1. android + cookies (no PO token needed, non-DRM with cookies)
  // 2. tv + cookies (same)
  // 3. ios + cookies (same)
  // 4. web + cookies (needs PO token — may get "format not available")
  // 5. android_vr without cookies (no PO token, no cookies — bot detection may block)
  // 6. default without cookies
  
  const cookieClients = ["android", "tv", "ios", "web"];
  const noCookieClients = ["android_vr", "android", "tv"];
  
  if (hasCookies) {
    for (const client of cookieClients) {
      const r = await downloadWithSystemYtDlp(videoUrl, outputFile, client, true);
      results.push(r);
      if (r.ok) return { success: true, result: r, results };
    }
  }
  
  for (const client of noCookieClients) {
    const r = await downloadWithSystemYtDlp(videoUrl, outputFile, client, false);
    results.push(r);
    if (r.ok) return { success: true, result: r, results };
  }

  // Also try npm package as last resort
  if (hasCookies) {
    for (const client of ["android", "tv"]) {
      const r = await downloadWithNpmYtDlp(videoUrl, outputFile, client, true);
      results.push(r);
      if (r.ok) return { success: true, result: r, results };
    }
  }
  {
    const r = await downloadWithNpmYtDlp(videoUrl, outputFile, "android_vr", false);
    results.push(r);
    if (r.ok) return { success: true, result: r, results };
  }

  return { success: false, result: null, results };
}

// ─── Tag MP3 ───
function tagMp3(inputFile, outputFile, metadata, artworkPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { fs.copyFileSync(inputFile, outputFile); resolve(); return; }
    let cmd = ffmpeg().input(inputFile);
    if (artworkPath && fs.existsSync(artworkPath)) cmd = cmd.input(artworkPath);
    const opts = [
      "-metadata", `title=${metadata.title}`,
      "-metadata", `artist=${metadata.artist}`,
      "-metadata", `album=${metadata.album}`,
      "-metadata", `comment=Downloaded via SideCut`,
    ];
    if (artworkPath && fs.existsSync(artworkPath)) {
      opts.push("-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic");
    }
    cmd.toFormat("mp3").audioBitrate(192).outputOptions(opts).save(outputFile)
      .on("end", resolve).on("error", reject);
  });
}

// ─── Routes ───
app.get("/", (req, res) => { res.send("SideCut backend is online!"); });
app.get("/health", (req, res) => { res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID, cookies: !!getCookieFile() }); });

app.get("/debug", async (req, res) => {
  let ytDlpVersion = null, ytDlpPath = null;
  try {
    const result = await execFileAsync("which", ["yt-dlp"], { timeout: 5000 });
    ytDlpPath = result.stdout.trim();
    const versionResult = await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    ytDlpVersion = versionResult.stdout.trim();
  } catch (e) {}
  const cookieFile = getCookieFile();
  let cookieInfo = "not configured";
  if (cookieFile) {
    try {
      const content = fs.readFileSync(cookieFile, "utf8");
      const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
      const hasYt = content.includes(".youtube.com") || content.includes(".google.com");
      cookieInfo = `configured (${lines.length} cookies, has YouTube: ${hasYt})`;
    } catch (e) { cookieInfo = "configured but error reading"; }
  }
  res.json({
    youtube_dl_exec: !!youtubedl, ffmpeg: !!ffmpeg, ffmpeg_path: ffmpegPath,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID, spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    system_yt_dlp: ytDlpPath ? { path: ytDlpPath, version: ytDlpVersion } : null,
    cookies: cookieInfo, node_version: process.version, platform: process.platform,
  });
});

app.get("/test-download", async (req, res) => {
  const testUrl = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";
  const testFile = "/tmp/sidecut_test.mp3";
  const { success, result, results } = await tryAllDownloads(testUrl, testFile);
  try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile); } catch(e) {}
  res.json({ success, results, winningMethod: result?.method || null });
});

// ─── /metadata ───
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
  } catch (error) { res.status(500).json({ success: false, error: "Failed to fetch metadata: " + error.message }); }
});

// ─── /download ───
app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  let artworkPath = null, rawFile = null, taggedFile = null;
  const tempFiles = [];
  try {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    const type = match[1], id = match[2];
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks supported. Use /metadata for albums/playlists." });

    await ensureSpotifyToken();
    const track = (await spotifyApi.getTrack(id)).body;
    const artistName = track.artists.map((a) => a.name).join(", ");
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = track.album.images[0]?.url || "";

    console.log(`Searching: "${artistName} ${trackName}"`);
    const searchResults = await ytSearch(`${artistName} ${trackName}`);
    const video = searchResults.videos[0];
    if (!video) return res.status(404).json({ success: false, error: "No matching audio found on YouTube" });
    console.log(`Found: ${video.title}`);

    if (artworkUrl) { try { artworkPath = `/tmp/artwork_${id}.jpg`; await downloadFile(artworkUrl, artworkPath); } catch (e) { artworkPath = null; } }

    rawFile = `/tmp/sidecut_raw_${id}_${Date.now()}.mp3`;
    tempFiles.push(rawFile);

    const { success, result, results } = await tryAllDownloads(video.url, rawFile);
    
    if (!success) {
      const errors = results.map(r => `[${r.method}]: ${r.error}`).join(" | ");
      const hasCookies = !!getCookieFile();
      return res.status(502).json({
        success: false,
        error: `Download failed. ${errors}`,
        hint: hasCookies ? "Cookies are configured but all clients failed. Cookies may be expired — re-export from youtube.com." : "Set YOUTUBE_COOKIES env var. Install 'Get cookies.txt LOCALLY' extension, visit youtube.com, export cookies.",
        video: { title: video.title, url: video.url, id: video.videoId }
      });
    }

    console.log(`Downloaded via ${result.method}: ${fs.statSync(rawFile).size} bytes`);

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
    console.error("Download error:", error.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed: " + error.message });
  }
  function cleanup() { [artworkPath, ...tempFiles].forEach((f) => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideCut backend running on port ${PORT}`));
