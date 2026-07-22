const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");

// â”€â”€â”€ Load YouTube download libraries â”€â”€â”€

let youtubedl = null;
try { youtubedl = require("youtube-dl-exec"); console.log("âœ“ youtube-dl-exec loaded"); } catch (e) { console.log("âœ— youtube-dl-exec not available"); }

let ytdl = null;
try { ytdl = require("@distube/ytdl-core"); console.log("âœ“ @distube/ytdl-core loaded"); } catch (e) { console.log("âœ— @distube/ytdl-core not available"); }

let ffmpeg = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  const fp = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(fp);
  console.log("âœ“ ffmpeg-static loaded");
} catch (e) { console.log("âœ— ffmpeg not available"); }

// â”€â”€â”€ Express â”€â”€â”€

const app = express();
app.use(cors());
app.use(express.json());

// â”€â”€â”€ Spotify API â”€â”€â”€

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID || "",
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
});

let tokenExpiry = 0;

async function ensureSpotifyToken() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error("Spotify credentials not configured");
  }
  if (Date.now() < tokenExpiry) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  tokenExpiry = Date.now() + (data.body.expires_in - 60) * 1000;
}

// â”€â”€â”€ Helper: download album art â”€â”€â”€

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}

// â”€â”€â”€ Get direct audio URL from YouTube (fast â€” no download) â”€â”€â”€

async function getAudioUrl(videoUrl) {
  // Method 1: youtube-dl-exec npm package
  if (youtubedl) {
    try {
      const result = await youtubedl(videoUrl, {
        print: "%(url)s",
        format: "bestaudio",
        noPlaylist: true,
        quiet: true,
      });
      const url = (result.stdout || result).toString().trim().split("\n")[0];
      if (url && url.startsWith("http")) {
        console.log("âœ“ Got audio URL via youtube-dl-exec");
        return url;
      }
    } catch (e) { console.log("youtube-dl-exec URL extraction failed:", e.message); }
  }

  // Method 2: yt-dlp system binary
  try {
    const result = await execFileAsync("yt-dlp", [
      "--print", "urls", "-f", "bestaudio", "--no-playlist", "--quiet", videoUrl,
    ], { timeout: 20000 });
    const url = result.stdout.trim().split("\n")[0];
    if (url && url.startsWith("http")) {
      console.log("âœ“ Got audio URL via yt-dlp binary");
      return url;
    }
  } catch (e) { console.log("yt-dlp binary URL extraction failed:", e.message); }

  return null;
}

// â”€â”€â”€ Routes â”€â”€â”€

app.get("/", (req, res) => { res.send("SideCut backend is online!"); });

app.get("/health", (req, res) => {
  res.json({ status: "ok", spotify: !!process.env.SPOTIFY_CLIENT_ID });
});

app.get("/debug", (req, res) => {
  res.json({
    youtube_dl_exec: !!youtubedl,
    ytdl_core: !!ytdl,
    ffmpeg: !!ffmpeg,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    node_version: process.version,
    platform: process.platform,
  });
});

// â”€â”€â”€ /metadata â”€â”€â”€

app.post("/metadata", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });

  try {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid Spotify link" });

    const type = match[1];
    const id = match[2];

    await ensureSpotifyToken();

    if (type === "track") {
      const trackData = await spotifyApi.getTrack(id);
      const track = trackData.body;
      res.json({
        success: true, type, id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(", "),
        album: track.album.name,
        artwork: track.album.images[0]?.url || "",
        duration: track.duration_ms,
        url,
      });
    } else if (type === "album") {
      const albumData = await spotifyApi.getAlbum(id);
      const album = albumData.body;
      res.json({
        success: true, type, id,
        title: album.name,
        artist: album.artists.map((a) => a.name).join(", "),
        album: album.name,
        artwork: album.images[0]?.url || "",
        trackCount: album.tracks.items.length,
        url,
      });
    } else if (type === "playlist") {
      const playlistData = await spotifyApi.getPlaylist(id);
      const playlist = playlistData.body;
      res.json({
        success: true, type, id,
        title: playlist.name,
        artist: playlist.owner?.display_name || "Various Artists",
        album: playlist.name,
        artwork: playlist.images[0]?.url || "",
        trackCount: playlist.tracks.items.length,
        url,
      });
    }
  } catch (error) {
    console.error("Metadata error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message.includes("Spotify credentials")
        ? "Server not configured with Spotify API credentials"
        : "Failed to fetch metadata: " + error.message,
    });
  }
});

// â”€â”€â”€ /download â€” streaming approach â”€â”€â”€

app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });

  let artworkPath = null;
  let tempFile = null;
  let ffmpegProcess = null;
  let audioStream = null;

  try {
    const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ success: false, error: "Invalid Spotify link" });

    const type = match[1];
    const id = match[2];

    if (type !== "track") {
      return res.status(400).json({ success: false, error: "Only individual tracks are supported" });
    }

    // 1. Get track metadata from Spotify
    await ensureSpotifyToken();
    const trackData = await spotifyApi.getTrack(id);
    const track = trackData.body;

    const artistName = track.artists.map((a) => a.name).join(", ");
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = track.album.images[0]?.url || "";

    // 2. Search YouTube
    const searchQuery = `${artistName} ${trackName}`;
    console.log(`Searching YouTube: "${searchQuery}"`);

    const searchResults = await ytSearch(searchQuery);
    const video = searchResults.videos[0];

    if (!video) {
      return res.status(404).json({ success: false, error: "No matching audio found on YouTube" });
    }

    console.log(`Found: ${video.title} â†’ ${video.url}`);

    // 3. Download album art (best-effort, non-blocking)
    if (artworkUrl) {
      try {
        artworkPath = `/tmp/artwork_${id}.jpg`;
        await downloadFile(artworkUrl, artworkPath);
      } catch (e) { artworkPath = null; }
    }

    // 4. Set response headers (early, so client knows data is coming)
    const safeFileName = `${artistName} - ${trackName}`.replace(/[^\w\s\-]/g, "_").trim();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.mp3"`);

    // â”€â”€ STREAMING APPROACH: get audio URL, pipe through ffmpeg â”€â”€

    const audioUrl = await getAudioUrl(video.url);

    if (audioUrl && ffmpeg) {
      console.log("Streaming from audio URL via ffmpeg...");

      // Build ffmpeg command: read from URL â†’ convert to MP3 â†’ pipe to response
      let ff = ffmpeg()
        .input(audioUrl)
        .format("mp3")
        .audioBitrate(192)
        .outputOptions([
          "-metadata", `title=${trackName}`,
          "-metadata", `artist=${artistName}`,
          "-metadata", `album=${albumName}`,
          "-metadata", `comment=Downloaded via SideCut`,
        ]);

      // Add album art if available
      if (artworkPath && fs.existsSync(artworkPath)) {
        ff = ff.input(artworkPath).outputOptions([
          "-map", "0:a", "-map", "1:v",
          "-c:v", "mjpeg", "-disposition:v:0", "attached_pic",
        ]);
      }

      ffmpegProcess = ff
        .on("error", (err) => {
          console.error("FFmpeg stream error:", err.message);
          if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Conversion failed: " + err.message });
          }
        })
        .on("end", () => {
          console.log(`Finished streaming: ${trackName}`);
          if (artworkPath) { try { fs.unlinkSync(artworkPath); } catch(e){} }
        });

      ffmpegProcess.pipe(res);

      req.on("close", () => {
        try { if (ffmpegProcess) ffmpegProcess.kill(); } catch (e) {}
        if (artworkPath) { try { fs.unlinkSync(artworkPath); } catch(e){} }
      });

    } else if (ytdl && ffmpeg) {
      // â”€â”€ FALLBACK 1: ytdl-core + ffmpeg streaming â”€â”€
      console.log("Falling back to ytdl-core + ffmpeg streaming...");

      audioStream = ytdl(video.url, { quality: "highestaudio", filter: "audioonly" });

      let ff = ffmpeg(audioStream)
        .format("mp3")
        .audioBitrate(192)
        .outputOptions([
          "-metadata", `title=${trackName}`,
          "-metadata", `artist=${artistName}`,
          "-metadata", `album=${albumName}`,
        ]);

      if (artworkPath && fs.existsSync(artworkPath)) {
        ff = ff.input(artworkPath).outputOptions([
          "-map", "0:a", "-map", "1:v",
          "-c:v", "mjpeg", "-disposition:v:0", "attached_pic",
        ]);
      }

      ffmpegProcess = ff
        .on("error", (err) => {
          console.error("ytdl+ffmpeg error:", err.message);
          if (!res.headersSent) {
            res.status(500).json({ success: false, error: "Conversion failed: " + err.message });
          }
        })
        .on("end", () => {
          console.log(`Finished: ${trackName}`);
          if (artworkPath) { try { fs.unlinkSync(artworkPath); } catch(e){} }
        });

      ffmpegProcess.pipe(res);

      req.on("close", () => {
        if (audioStream) audioStream.destroy();
        try { if (ffmpegProcess) ffmpegProcess.kill(); } catch (e) {}
        if (artworkPath) { try { fs.unlinkSync(artworkPath); } catch(e){} }
      });

    } else if (youtubedl) {
      // â”€â”€ FALLBACK 2: youtube-dl-exec to temp file, then stream â”€â”€
      console.log("Falling back to youtube-dl-exec temp file...");

      tempFile = `/tmp/SideCut_${id}.mp3`;
      await youtubedl(video.url, {
        extractAudio: true,
        audioFormat: "mp3",
        audioQuality: 5, // medium quality for faster download
        output: tempFile,
        noPlaylist: true,
        noWarnings: true,
      });

      const fileStream = fs.createReadStream(tempFile);
      fileStream.pipe(res);
      fileStream.on("end", () => { cleanupFiles(); });
      fileStream.on("error", (err) => {
        if (!res.headersSent) res.status(500).json({ success: false, error: "Stream error" });
        cleanupFiles();
      });
      req.on("close", () => { cleanupFiles(); });

    } else {
      return res.status(500).json({
        success: false,
        error: "No YouTube download method available on this server",
      });
    }

  } catch (error) {
    console.error("Download error:", error.message);
    cleanupFiles();
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message.includes("Spotify credentials")
          ? "Server not configured with Spotify API credentials"
          : "Download failed: " + error.message,
      });
    }
  }

  function cleanupFiles() {
    [artworkPath, tempFile].forEach((f) => {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`SideCut backend running on port ${PORT}`); });
