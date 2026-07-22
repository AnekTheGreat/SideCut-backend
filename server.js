const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");
const ytdl = require("@distube/ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Spotify API â€” client-credentials flow (no user login needed)
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Helper â€” download a file over HTTPS (for album art)
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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
      file.on("finish", () => {
        file.close();
        resolve(dest);
      });
    }).on("error", (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Health check
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.get("/", (req, res) => {
  res.send("SideCut backend is online!");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    spotify: !!process.env.SPOTIFY_CLIENT_ID,
  });
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   /metadata  â€”  read real track info from Spotify
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post("/metadata", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  try {
    const match = url.match(
      /spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/
    );

    if (!match) {
      return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    }

    const type = match[1];
    const id = match[2];

    await ensureSpotifyToken();

    if (type === "track") {
      const trackData = await spotifyApi.getTrack(id);
      const track = trackData.body;

      res.json({
        success: true,
        type,
        id,
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
        success: true,
        type,
        id,
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
        success: true,
        type,
        id,
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
        : "Failed to fetch metadata",
    });
  }
});

/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   /download  â€”  search YouTube, stream back MP3
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  let audioStream = null;
  let ffmpegProcess = null;
  let artworkPath = null;

  try {
    const match = url.match(
      /spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/
    );

    if (!match) {
      return res.status(400).json({ success: false, error: "Invalid Spotify link" });
    }

    const type = match[1];
    const id = match[2];

    if (type !== "track") {
      return res.status(400).json({
        success: false,
        error: "Only individual tracks are supported for download right now",
      });
    }

    // 1. Get real track metadata from Spotify
    await ensureSpotifyToken();
    const trackData = await spotifyApi.getTrack(id);
    const track = trackData.body;

    const artistName = track.artists.map((a) => a.name).join(", ");
    const trackName = track.name;
    const albumName = track.album.name;
    const artworkUrl = track.album.images[0]?.url || "";

    // 2. Search YouTube for matching audio
    const searchQuery = `${artistName} ${trackName}`;
    console.log(`Searching YouTube: "${searchQuery}"`);

    const searchResults = await ytSearch(searchQuery);
    const video = searchResults.videos[0];

    if (!video) {
      return res.status(404).json({
        success: false,
        error: "No matching audio found on YouTube",
      });
    }

    console.log(`Found: ${video.title} â†’ ${video.url}`);

    // 3. Download album art (best-effort, non-blocking on failure)
    if (artworkUrl) {
      try {
        artworkPath = `/tmp/artwork_${id}.jpg`;
        await downloadFile(artworkUrl, artworkPath);
        console.log("Album art downloaded");
      } catch (e) {
        console.warn("Album art download failed:", e.message);
        artworkPath = null;
      }
    }

    // 4. Get audio stream from YouTube
    audioStream = ytdl(video.url, {
      quality: "highestaudio",
      filter: "audioonly",
    });

    // 5. Set response headers
    const safeFileName = `${artistName} - ${trackName}`
      .replace(/[^\w\s\-]/g, "_")
      .trim();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName}.mp3"`
    );

    // 6. Build ffmpeg command â€” convert to MP3 with embedded metadata + album art
    let ffCommand = ffmpeg(audioStream);

    if (artworkPath) {
      ffCommand = ffCommand.input(artworkPath);
    }

    const outputOptions = [];

    if (artworkPath) {
      outputOptions.push("-map", "0:a", "-map", "1:v");
      outputOptions.push("-c:v", "mjpeg");
      outputOptions.push("-disposition:v:0", "attached_pic");
    }

    outputOptions.push(
      "-metadata", `title=${trackName}`,
      "-metadata", `artist=${artistName}`,
      "-metadata", `album=${albumName}`,
      "-metadata", `date=${track.album.release_date?.split("-")[0] || ""}`,
      "-metadata", `comment=Downloaded via SideCut`,
    );

    ffmpegProcess = ffCommand
      .toFormat("mp3")
      .audioBitrate(320)
      .outputOptions(outputOptions)
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: "Audio conversion failed",
          });
        }
      })
      .on("end", () => {
        console.log(`Finished converting: ${trackName}`);
        if (artworkPath) fs.unlink(artworkPath, () => {});
      });

    // 7. Pipe the MP3 stream to the client
    ffmpegProcess.pipe(res);

    // 8. Clean up if the client disconnects early
    req.on("close", () => {
      if (audioStream) audioStream.destroy();
      try {
        if (ffmpegProcess) ffmpegProcess.kill();
      } catch (e) {}
      if (artworkPath) fs.unlink(artworkPath, () => {});
    });
  } catch (error) {
    console.error("Download error:", error.message);
    if (audioStream) audioStream.destroy();
    try {
      if (ffmpegProcess) ffmpegProcess.kill();
    } catch (e) {}
    if (artworkPath) fs.unlink(artworkPath, () => {});
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message.includes("Spotify credentials")
          ? "Server not configured with Spotify API credentials"
          : "Server error",
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SideCut backend running on port ${PORT}`);
});
