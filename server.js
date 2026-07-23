const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile, exec } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");

// ─── Load libraries ───
let youtubedl = null;
try { youtubedl = require("youtube-dl-exec"); console.log("✓ youtube-dl-exec loaded"); } catch (e) { console.log("✗ youtube-dl-exec not available"); }
let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegPath = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("✓ ffmpeg-static loaded:", ffmpegPath);
} catch (e) { console.log("✗ ffmpeg not available"); }

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

// ─── Helpers ───
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); fs.unlink(dest, () => {}); downloadFile(res.headers.location, dest).then(resolve).catch(reject); return; }
      res.pipe(file); file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}

// ─── Download audio using system yt-dlp with android_vr client (no PO token needed) ───
async function downloadWithSystemYtDlp(videoUrl, outputFile) {
  try {
    const ytDlpVersion = await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 }).then(r => r.stdout.trim()).catch(() => "unknown");
    console.log(`System yt-dlp version: ${ytDlpVersion}`);
    
    const args = [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile,
      "--no-playlist", "--no-warnings", "--no-check-certificates",
      "--extractor-args", "youtube:player_client=android_vr",
    ];
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    
    console.log("Running: yt-dlp", args.join(" "));
    await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ yt-dlp download succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: "system-yt-dlp", version: ytDlpVersion };
    }
    return { ok: false, method: "system-yt-dlp", error: "File too small or missing" };
  } catch (e) {
    console.log("✗ system yt-dlp failed:", e.message);
    return { ok: false, method: "system-yt-dlp", error: e.message };
  }
}

// ─── Download audio using youtube-dl-exec npm package with android_vr client ───
async function downloadWithNpmYtDlp(videoUrl, outputFile) {
  if (!youtubedl) return { ok: false, method: "npm-yt-dlp", error: "package not loaded" };
  try {
    console.log("Trying youtube-dl-exec with android_vr...");
    const opts = {
      extractAudio: true, audioFormat: "mp3", audioQuality: 5,
      output: outputFile, noPlaylist: true, noWarnings: true,
      extractorArgs: "youtube:player_client=android_vr",
    };
    if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
    await youtubedl(videoUrl, opts);
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ youtube-dl-exec succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: "npm-yt-dlp" };
    }
    return { ok: false, method: "npm-yt-dlp", error: "File too small or missing" };
  } catch (e) {
    console.log("✗ youtube-dl-exec failed:", e.message);
    return { ok: false, method: "npm-yt-dlp", error: e.message };
  }
}

// ─── Download audio using YouTube player API (ANDROID_VR) + direct download ───
async function downloadWithPlayerApi(videoId, outputFile) {
  try {
    console.log("Trying YouTube player API (ANDROID_VR)...");
    const VR_UA = "com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 11)";
    const body = JSON.stringify({
      videoId,
      context: { client: { clientName: "ANDROID_VR", clientVersion: "1.56.21", hl: "en", gl: "US" } },
    });
    const resp = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": VR_UA },
      body,
    });
    const data = await resp.json();
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audioFormats = formats.filter((f) => f.mimeType?.includes("audio"));
    
    if (audioFormats.length === 0) {
      return { ok: false, method: "player-api", error: `No audio formats, status: ${data?.playabilityStatus?.status}` };
    }
    
    const best = audioFormats.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a);
    console.log(`✓ Player API: got URL (${best.mimeType}, ${best.bitrate}bps)`);
    
    // Download the audio file
    const rawFile = outputFile.replace(/\.mp3$/, ".webm");
    const file = fs.createWriteStream(rawFile);
    await new Promise((resolve, reject) => {
      https.get(best.url, { headers: { "User-Agent": VR_UA } }, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    });
    
    if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size < 1000) {
      return { ok: false, method: "player-api", error: "Download too small" };
    }
    
    // Convert to MP3 with ffmpeg
    if (ffmpeg && ffmpegPath) {
      await new Promise((resolve, reject) => {
        ffmpeg().input(rawFile).toFormat("mp3").audioBitrate(192).save(outputFile)
          .on("end", resolve).on("error", reject);
      });
      fs.unlinkSync(rawFile);
    } else {
      fs.renameSync(rawFile, outputFile);
    }
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ Player API download succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: "player-api" };
    }
    return { ok: false, method: "player-api", error: "Conversion failed" };
  } catch (e) {
    console.log("✗ Player API failed:", e.message);
    return { ok: false, method: "player-api", error: e.message };
  }
}

// ─── Tag MP3 with metadata + album art ───
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
app.get("/health", (req, res) => { res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID }); });

app.get("/debug", async (req, res) => {
  // Check system yt-dlp
  let ytDlpVersion = null, ytDlpPath = null;
  try {
    const result = await execFileAsync("which", ["yt-dlp"], { timeout: 5000 });
    ytDlpPath = result.stdout.trim();
    const versionResult = await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    ytDlpVersion = versionResult.stdout.trim();
  } catch (e) { ytDlpPath = null; ytDlpVersion = null; }
  
  res.json({
    youtube_dl_exec: !!youtubedl,
    ffmpeg: !!ffmpeg,
    ffmpeg_path: ffmpegPath,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    system_yt_dlp: ytDlpPath ? { path: ytDlpPath, version: ytDlpVersion } : null,
    node_version: process.version,
    platform: process.platform,
  });
});

// Diagnostic endpoint — tries to download a test video and reports what happened
app.get("/test-download", async (req, res) => {
  const testUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const testFile = "/tmp/sidecut_test.mp3";
  const results = [];
  
  // Method 1: system yt-dlp
  const r1 = await downloadWithSystemYtDlp(testUrl, testFile);
  results.push(r1);
  if (r1.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  // Method 2: npm youtube-dl-exec
  const r2 = await downloadWithNpmYtDlp(testUrl, testFile);
  results.push(r2);
  if (r2.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  // Method 3: player API
  const r3 = await downloadWithPlayerApi("dQw4w9WgXcQ", testFile);
  results.push(r3);
  if (r3.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  res.json({ success: false, results });
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
      res.json({ success: true, type, id, title: d.name, artist: d.artists.map((a) => a.name).join(", "), album: d.name, artwork: d.images[0]?.url || "", trackCount: d.tracks.items.length, url });
    } else if (type === "playlist") {
      const d = (await spotifyApi.getPlaylist(id)).body;
      res.json({ success: true, type, id, title: d.name, artist: d.owner?.display_name || "Various Artists", album: d.name, artwork: d.images[0]?.url || "", trackCount: d.tracks.items.length, url });
    }
  } catch (error) {
    console.error("Metadata error:", error.message);
    res.status(500).json({ success: false, error: "Failed to fetch metadata: " + error.message });
  }
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
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks are supported" });

    // 1. Spotify metadata
    await ensureSpotifyToken();
    const track = (await spotifyApi.getTrack(id)).body;
    const artistName = track.artists.map((a) => a.name).join(", ");
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = track.album.images[0]?.url || "";

    // 2. Search YouTube
    console.log(`Searching: "${artistName} ${trackName}"`);
    const searchResults = await ytSearch(`${artistName} ${trackName}`);
    const video = searchResults.videos[0];
    if (!video) return res.status(404).json({ success: false, error: "No matching audio found on YouTube" });
    console.log(`Found: ${video.title}`);

    const videoId = video.videoId || (video.url && video.url.split("v=")[1]?.split("&")[0]);
    if (!videoId) return res.status(500).json({ success: false, error: "Could not extract video ID" });

    // 3. Download album art
    if (artworkUrl) {
      try { artworkPath = `/tmp/artwork_${id}.jpg`; await downloadFile(artworkUrl, artworkPath); } catch (e) { artworkPath = null; }
    }

    // 4. Download audio — try each method until one works
    rawFile = `/tmp/sidecut_raw_${id}.mp3`;
    tempFiles.push(rawFile);
    
    let downloadResult = null;
    
    // Method 1: system yt-dlp with android_vr
    downloadResult = await downloadWithSystemYtDlp(video.url, rawFile);
    if (!downloadResult.ok) {
      // Method 2: npm youtube-dl-exec with android_vr
      downloadResult = await downloadWithNpmYtDlp(video.url, rawFile);
    }
    if (!downloadResult.ok) {
      // Method 3: YouTube player API (ANDROID_VR)
      downloadResult = await downloadWithPlayerApi(videoId, rawFile);
    }
    
    if (!downloadResult.ok) {
      const errors = [downloadResult].map(r => `${r.method}: ${r.error}`).join("; ");
      return res.status(502).json({ 
        success: false, 
        error: `All download methods failed. ${errors}`,
        video: { title: video.title, url: video.url, id: videoId }
      });
    }

    console.log(`Downloaded via ${downloadResult.method}: ${fs.statSync(rawFile).size} bytes`);

    // 5. Add metadata + album art
    taggedFile = `/tmp/sidecut_tagged_${id}.mp3`;
    tempFiles.push(taggedFile);
    
    try {
      await tagMp3(rawFile, taggedFile, { title: trackName, artist: artistName, album: albumName }, artworkPath);
      console.log("Tagged with metadata + artwork");
    } catch (e) {
      console.warn("Tagging failed, using raw:", e.message);
      fs.copyFileSync(rawFile, taggedFile);
    }

    // 6. Stream to client
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

  function cleanup() {
    [artworkPath, ...tempFiles].forEach((f) => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideCut backend running on port ${PORT}`));
