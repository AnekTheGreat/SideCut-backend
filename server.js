const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile, exec } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
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

// ─── Run yt-dlp and capture FULL output ───
async function runYtDlp(args) {
  try {
    const { stdout, stderr } = await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 50 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || e.message || "" };
  }
}

// ─── Download audio: try multiple format strategies ───
async function downloadAudio(videoUrl, outputFile, useCookies) {
  const cookieFile = useCookies ? getCookieFile() : null;
  const hasCookies = !!cookieFile;
  
  // Strategy list: [client, formatArgs, extractAudio]
  // Key insight: "format not available" means audio-only formats are missing.
  // Fix: try downloading video+audio (format "best") and extract audio with ffmpeg.
  const strategies = [];
  
  if (hasCookies) {
    // With cookies — these clients don't need PO token
    // Try audio-only first, then video+audio as fallback
    strategies.push({ client: "android", fmt: "bestaudio/best", extractAudio: true, useCookies: true });
    strategies.push({ client: "tv", fmt: "bestaudio/best", extractAudio: true, useCookies: true });
    strategies.push({ client: "ios", fmt: "bestaudio/best", extractAudio: true, useCookies: true });
    // Fallback: download video+audio, extract audio later
    strategies.push({ client: "android", fmt: "best", extractAudio: false, useCookies: true });
    strategies.push({ client: "tv", fmt: "best", extractAudio: false, useCookies: true });
  }
  
  // Without cookies — android_vr doesn't need PO token
  strategies.push({ client: "android_vr", fmt: "bestaudio/best", extractAudio: true, useCookies: false });
  strategies.push({ client: "android_vr", fmt: "best", extractAudio: false, useCookies: false });
  
  const results = [];
  
  for (const s of strategies) {
    const label = `yt-dlp[${s.client}+${s.fmt}${s.useCookies ? "+cookies" : ""}]`;
    console.log(`Trying ${label}...`);
    
    const args = [
      "--no-playlist", "--no-warnings", "--no-check-certificates",
      "--no-check-formats", // Skip format availability check
      "-o", outputFile.replace(/\.mp3$/, ".%(ext)s"),
      "--format", s.fmt,
    ];
    
    if (s.extractAudio) {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "5");
    }
    
    if (s.client) {
      args.push("--extractor-args", `youtube:player_client=${s.client}`);
    }
    
    if (s.useCookies && cookieFile) {
      args.push("--cookies", cookieFile);
    }
    
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    
    const result = await runYtDlp(args);
    
    if (result.ok) {
      // Find the actual output file (extension might vary)
      const baseName = outputFile.replace(/\.mp3$/, "");
      const possibleFiles = [outputFile, `${baseName}.mp3`, `${baseName}.webm`, `${baseName}.m4a`, `${baseName}.mp4`, `${baseName}.mkv`];
      let foundFile = null;
      for (const f of possibleFiles) {
        if (fs.existsSync(f) && fs.statSync(f).size > 1000) { foundFile = f; break; }
      }
      
      if (foundFile) {
        // If it's not MP3, convert with ffmpeg
        if (foundFile !== outputFile) {
          if (ffmpeg && ffmpegPath) {
            try {
              await new Promise((resolve, reject) => {
                ffmpeg().input(foundFile).toFormat("mp3").audioBitrate(192).save(outputFile)
                  .on("end", resolve).on("error", reject);
              });
              try { fs.unlinkSync(foundFile); } catch(e) {}
            } catch (e) {
              fs.copyFileSync(foundFile, outputFile);
              try { fs.unlinkSync(foundFile); } catch(e) {}
            }
          } else {
            fs.copyFileSync(foundFile, outputFile);
            try { fs.unlinkSync(foundFile); } catch(e) {}
          }
        }
        
        if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
          console.log(`✓ ${label} succeeded: ${fs.statSync(outputFile).size} bytes`);
          return { ok: true, method: label, results };
        }
      }
    }
    
    const errLine = result.stderr.split("\n").find(l => l.includes("ERROR")) || result.stderr.substring(0, 200);
    results.push({ method: label, error: errLine || "Unknown error" });
    console.log(`✗ ${label} failed: ${errLine}`);
    
    // Clean up any partial files
    const baseName = outputFile.replace(/\.mp3$/, "");
    [outputFile, `${baseName}.mp3`, `${baseName}.webm`, `${baseName}.m4a`, `${baseName}.mp4`, `${baseName}.mkv`].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
    });
  }
  
  return { ok: false, results };
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

// DIAGNOSTIC: Show available formats with cookies
app.get("/diag", async (req, res) => {
  const videoUrl = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";
  const cookieFile = getCookieFile();
  const output = {};
  
  // List formats with different clients
  const clients = cookieFile ? ["android", "tv", "web"] : ["android_vr"];
  
  for (const client of clients) {
    const args = ["--list-formats", "--no-playlist", "--no-warnings", "--extractor-args", `youtube:player_client=${client}`];
    if (cookieFile) args.push("--cookies", cookieFile);
    args.push(videoUrl);
    
    const result = await runYtDlp(args);
    output[client + (cookieFile ? "_cookies" : "")] = {
      ok: result.ok,
      stderr: result.stderr.substring(0, 2000),
      stdout: result.stdout.substring(0, 3000),
    };
  }
  
  // Also try dumping JSON to see format details
  if (cookieFile) {
    const args = ["--dump-json", "--no-playlist", "--no-warnings", "--extractor-args", "youtube:player_client=android", "--cookies", cookieFile, videoUrl];
    const result = await runYtDlp(args);
    if (result.ok) {
      try {
        const json = JSON.parse(result.stdout);
        output.json_dump = {
          title: json.title,
          formats: (json.formats || []).map(f => ({
            format_id: f.format_id, ext: f.ext, acodec: f.acodec, vcodec: f.vcodec,
            abr: f.abr, filesize: f.filesize, url: f.url ? "present" : "missing",
            protocol: f.protocol, drm: f.drm || "none",
          })),
        };
      } catch (e) {
        output.json_dump = { error: e.message, raw: result.stdout.substring(0, 500) };
      }
    } else {
      output.json_dump = { error: result.stderr.substring(0, 500) };
    }
  }
  
  res.json(output);
});

app.get("/test-download", async (req, res) => {
  const testUrl = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";
  const testFile = "/tmp/sidecut_test.mp3";
  const { ok, method, results } = await downloadAudio(testUrl, testFile, !!getCookieFile());
  try { if (fs.existsSync(testFile)) fs.unlinkSync(testFile); } catch(e) {}
  res.json({ success: ok, winningMethod: method, results: results || [] });
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

    const { ok, method, results } = await downloadAudio(video.url, rawFile, !!getCookieFile());
    
    if (!ok) {
      const errors = (results || []).map(r => `[${r.method}]: ${r.error}`).join(" | ");
      return res.status(502).json({
        success: false,
        error: `Download failed. ${errors}`,
        hint: "Check /diag for format details and /debug for cookie info.",
        video: { title: video.title, url: video.url, id: video.videoId }
      });
    }

    console.log(`Downloaded via ${method}: ${fs.statSync(rawFile).size} bytes`);

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
