const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");

// ─── Load libraries ───
let youtubedl = null;
try { youtubedl = require("youtube-dl-exec"); console.log("✓ youtube-dl-exec loaded"); } catch (e) { console.log("✗ youtube-dl-exec not available"); }
let ytdl = null;
try { ytdl = require("@distube/ytdl-core"); console.log("✓ @distube/ytdl-core loaded"); } catch (e) { console.log("✗ @distube/ytdl-core not available"); }
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

const VR_UA = "com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 11)";

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

// ─── PRIMARY: YouTube internal player API (ANDROID_VR client — bypasses bot detection) ───
async function getAudioUrlFromPlayerApi(videoId) {
  try {
    console.log("Trying YouTube player API (ANDROID_VR)...");
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
      console.log("✗ Player API: no audio formats, status:", data?.playabilityStatus?.status);
      return null;
    }
    const best = audioFormats.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a);
    console.log(`✓ Player API: got audio URL (${best.mimeType}, ${best.bitrate}bps)`);
    return best.url;
  } catch (e) {
    console.log("✗ Player API failed:", e.message);
    return null;
  }
}

// ─── FALLBACK 1: system yt-dlp direct download to temp file ───
async function downloadWithYtDlp(videoUrl, outputFile) {
  try {
    console.log("Trying system yt-dlp...");
    const args = ["-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates"];
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    await execFileAsync("yt-dlp", args, { timeout: 90000 });
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) { console.log("✓ yt-dlp succeeded"); return true; }
  } catch (e) { console.log("✗ yt-dlp failed:", e.message); }
  return false;
}

// ─── FALLBACK 2: youtube-dl-exec npm package ───
async function downloadWithNpm(videoUrl, outputFile) {
  if (!youtubedl) return false;
  try {
    console.log("Trying youtube-dl-exec...");
    const opts = { extractAudio: true, audioFormat: "mp3", audioQuality: 5, output: outputFile, noPlaylist: true, noWarnings: true };
    if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
    await youtubedl(videoUrl, opts);
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) { console.log("✓ youtube-dl-exec succeeded"); return true; }
  } catch (e) { console.log("✗ youtube-dl-exec failed:", e.message); }
  return false;
}

// ─── Routes ───
app.get("/", (req, res) => { res.send("SideCut backend is online!"); });
app.get("/health", (req, res) => { res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID }); });
app.get("/debug", (req, res) => {
  res.json({
    youtube_dl_exec: !!youtubedl, ytdl_core: !!ytdl, ffmpeg: !!ffmpeg,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    node_version: process.version, platform: process.platform,
  });
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
  let artworkPath = null, tempFile = null;

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

    // 4. Get audio URL via YouTube player API (ANDROID_VR — bypasses bot detection)
    const audioUrl = await getAudioUrlFromPlayerApi(videoId);

    if (audioUrl && ffmpeg) {
      // ─── STREAMING: pipe audio URL → ffmpeg → MP3 → response ───
      console.log("Streaming via ffmpeg...");
      const safeFileName = `${artistName} - ${trackName}`.replace(/[^\w\s\-]/g, "_").trim();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.mp3"`);

      let ff = ffmpeg()
        .input(audioUrl)
        .inputOptions([
          "-user_agent", VR_UA,
          "-headers", "Referer: https://www.youtube.com\r\n",
        ])
        .format("mp3")
        .audioBitrate(192)
        .outputOptions([
          "-metadata", `title=${trackName}`,
          "-metadata", `artist=${artistName}`,
          "-metadata", `album=${albumName}`,
          "-metadata", `comment=Downloaded via SideCut`,
        ]);

      if (artworkPath && fs.existsSync(artworkPath)) {
        ff = ff.input(artworkPath).outputOptions(["-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic"]);
      }

      const proc = ff.on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: "Conversion failed: " + err.message });
        cleanup();
      }).on("end", () => { console.log(`✓ Done: ${trackName}`); cleanup(); });

      proc.pipe(res);
      req.on("close", () => { try { proc.kill(); } catch (e) {} cleanup(); });

    } else {
      // ─── FALLBACK: download to temp file, then stream ───
      console.log("Player API failed, falling back to yt-dlp...");
      tempFile = `/tmp/sidecut_${id}.mp3`;
      let ok = await downloadWithYtDlp(video.url, tempFile);
      if (!ok) ok = await downloadWithNpm(video.url, tempFile);
      if (!ok) {
        return res.status(502).json({ success: false, error: "Could not download audio — YouTube may be blocking this server" });
      }

      // Add metadata with ffmpeg
      if (ffmpeg && artworkPath && fs.existsSync(artworkPath)) {
        const tagged = `/tmp/sidecut_tagged_${id}.mp3`;
        try {
          await new Promise((resolve, reject) => {
            ffmpeg().input(tempFile).input(artworkPath)
              .outputOptions(["-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic",
                "-metadata", `title=${trackName}`, "-metadata", `artist=${artistName}`, "-metadata", `album=${albumName}`])
              .toFormat("mp3").audioBitrate(192).save(tagged).on("end", resolve).on("error", reject);
          });
          fs.unlinkSync(tempFile);
          tempFile = tagged;
        } catch (e) { console.warn("Tagging failed:", e.message); }
      }

      const safeFileName = `${artistName} - ${trackName}`.replace(/[^\w\s\-]/g, "_").trim();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.mp3"`);
      const stream = fs.createReadStream(tempFile);
      stream.pipe(res);
      stream.on("end", cleanup);
      stream.on("error", cleanup);
      req.on("close", cleanup);
    }

  } catch (error) {
    console.error("Download error:", error.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ success: false, error: "Download failed: " + error.message });
  }

  function cleanup() {
    [artworkPath, tempFile].forEach((f) => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideCut backend running on port ${PORT}`));
