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

// Download audio from YouTube to a temp file (direct download works, URL extraction doesn't)
async function downloadYouTubeAudio(videoUrl, outputFile) {
  // Method 1: system yt-dlp binary (fastest, handles bot detection internally)
  try {
    console.log("Trying system yt-dlp...");
    const args = [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile, "--no-playlist", "--no-warnings",
      "--no-check-certificates",
    ];
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    await execFileAsync("yt-dlp", args, { timeout: 90000 });
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log("✓ yt-dlp download succeeded");
      return;
    }
  } catch (e) { console.log("✗ yt-dlp failed:", e.message); }

  // Method 2: youtube-dl-exec npm package
  if (youtubedl) {
    try {
      console.log("Trying youtube-dl-exec...");
      const opts = {
        extractAudio: true, audioFormat: "mp3", audioQuality: 5,
        output: outputFile, noPlaylist: true, noWarnings: true,
      };
      if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
      await youtubedl(videoUrl, opts);
      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        console.log("✓ youtube-dl-exec download succeeded");
        return;
      }
    } catch (e) { console.log("✗ youtube-dl-exec failed:", e.message); }
  }

  // Method 3: ytdl-core + fluent-ffmpeg (stream to file)
  if (ytdl && ffmpeg) {
    try {
      console.log("Trying ytdl-core + ffmpeg...");
      const audioStream = ytdl(videoUrl, { quality: "highestaudio", filter: "audioonly" });
      await new Promise((resolve, reject) => {
        ffmpeg(audioStream).toFormat("mp3").audioBitrate(192).save(outputFile).on("end", resolve).on("error", reject);
      });
      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        console.log("✓ ytdl-core + ffmpeg succeeded");
        return;
      }
    } catch (e) { console.log("✗ ytdl-core failed:", e.message); }
  }

  throw new Error("All download methods failed — YouTube may be blocking this server");
}

// Add metadata + album art to an MP3 file
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
  let artworkPath = null, rawFile = null, taggedFile = null;

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

    // 3. Download album art
    if (artworkUrl) {
      try { artworkPath = `/tmp/artwork_${id}.jpg`; await downloadFile(artworkUrl, artworkPath); } catch (e) { artworkPath = null; }
    }

    // 4. Download audio to temp file
    rawFile = `/tmp/sidecut_raw_${id}.mp3`;
    taggedFile = `/tmp/sidecut_tagged_${id}.mp3`;

    await downloadYouTubeAudio(video.url, rawFile);
    console.log(`Downloaded: ${fs.statSync(rawFile).size} bytes`);

    // 5. Add metadata + album art
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
    [artworkPath, rawFile, taggedFile].forEach((f) => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SideCut backend running on port ${PORT}`));
