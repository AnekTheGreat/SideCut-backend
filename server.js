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

const app = express();
app.use(cors());
app.use(express.json());

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

// Run yt-dlp and capture FULL output (no truncation)
async function runYtDlpRaw(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile("yt-dlp", args, { timeout, maxBuffer: 1024 * 1024 * 50, cwd: "/tmp" }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout || "",
        stderr: stderr || (err ? err.message : ""),
      });
    });
  });
}

// ─── DIAGNOSTIC: list formats with every client+cookie combo ───
app.get("/diag", async (req, res) => {
  const videoUrl = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";
  const cookieFile = getCookieFile();
  const output = { cookies: cookieFile ? "yes" : "no", results: {} };

  const combos = [];
  // With cookies
  if (cookieFile) {
    combos.push(["android_vr", true]);
    combos.push(["android", true]);
    combos.push(["tv", true]);
    combos.push(["web", true]);
    combos.push(["default", true]); // no extractor-args, let yt-dlp pick
  }
  // Without cookies
  combos.push(["android_vr", false]);
  combos.push(["default", false]);

  for (const [client, useCookies] of combos) {
    const key = `${client}${useCookies ? "+cookies" : ""}`;
    const args = ["--list-formats", "--no-playlist", "--no-warnings"];
    if (client !== "default") args.push("--extractor-args", `youtube:player_client=${client}`);
    if (useCookies && cookieFile) args.push("--cookies", cookieFile);
    args.push(videoUrl);

    const result = await runYtDlpRaw(args, 60000);
    output.results[key] = {
      ok: result.ok,
      // Show full stderr (contains the format list or error)
      output: (result.stderr + "\n" + result.stdout).trim().substring(0, 3000),
    };
  }

  // Also dump JSON for android_vr+cookies to see format details
  if (cookieFile) {
    const args = ["--dump-json", "--no-playlist", "--no-warnings", "--extractor-args", "youtube:player_client=android_vr", "--cookies", cookieFile, videoUrl];
    const result = await runYtDlpRaw(args, 60000);
    if (result.ok) {
      try {
        const json = JSON.parse(result.stdout);
        output.json_dump = {
          title: json.title,
          format_count: (json.formats || []).length,
          formats: (json.formats || []).slice(0, 10).map(f => ({
            id: f.format_id, ext: f.ext, acodec: f.acodec, vcodec: f.vcodec,
            abr: f.abr, tbr: f.tbr, protocol: f.protocol,
            has_url: !!f.url, drm: f.drm || "none",
          })),
        };
      } catch (e) { output.json_dump = { error: e.message, raw: result.stdout.substring(0, 500) }; }
    } else {
      output.json_dump = { error: result.stderr.substring(0, 1000) };
    }
  }

  res.json(output);
});

// ─── Download: try android_vr+cookies first (no PO token needed) ───
async function tryDownload(videoUrl, outputFile) {
  const cookieFile = getCookieFile();
  const strategies = [];

  // NEW: android_vr + cookies — this client doesn't need PO token AND cookies might bypass bot detection
  if (cookieFile) {
    strategies.push({ client: "android_vr", cookies: true, label: "android_vr+cookies" });
  }
  // android_vr without cookies (works for some videos)
  strategies.push({ client: "android_vr", cookies: false, label: "android_vr" });

  // Other clients as fallback
  if (cookieFile) {
    strategies.push({ client: "android", cookies: true, label: "android+cookies" });
    strategies.push({ client: "tv", cookies: true, label: "tv+cookies" });
  }
  // Default (let yt-dlp pick) with and without cookies
  if (cookieFile) strategies.push({ client: null, cookies: true, label: "default+cookies" });
  strategies.push({ client: null, cookies: false, label: "default" });

  const results = [];
  for (const s of strategies) {
    const args = ["-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates"];
    if (s.client) args.push("--extractor-args", `youtube:player_client=${s.client}`);
    if (s.cookies && cookieFile) args.push("--cookies", cookieFile);
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);

    console.log(`Trying ${s.label}...`);
    const result = await runYtDlpRaw(args);

    if (result.ok && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ ${s.label} succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: s.label, results };
    }

    const errorLine = result.stderr.split("\n").find(l => l.includes("ERROR")) || result.stderr.substring(0, 300);
    results.push({ method: s.label, error: errorLine });
    console.log(`✗ ${s.label}: ${errorLine}`);
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
    youtube_dl_exec: !!youtubedl, ffmpeg: !!ffmpeg, ffmpeg_path: ffmpegPath,
    spotify: !!process.env.SPOTIFY_CLIENT_ID, cookies: getCookieFile() ? "configured" : "not configured",
    yt_dlp_version: ytDlpVersion,
  });
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
