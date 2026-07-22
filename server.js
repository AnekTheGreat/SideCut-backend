const express = require("express");
const cors = require("cors");
const https = require("https");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const SpotifyWebApi = require("spotify-web-api-node");
const ytSearch = require("yt-search");

// â”€â”€â”€ Load YouTube download libraries (any one of these will work) â”€â”€â”€

let youtubedl = null;
try {
  youtubedl = require("youtube-dl-exec");
  console.log("âœ“ youtube-dl-exec loaded");
} catch (e) {
  console.log("âœ— youtube-dl-exec not available");
}

let ytdl = null;
try {
  ytdl = require("@distube/ytdl-core");
  console.log("âœ“ @distube/ytdl-core loaded");
} catch (e) {
  console.log("âœ— @distube/ytdl-core not available");
}

let ffmpeg = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  const fp = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(fp);
  console.log("âœ“ ffmpeg-static loaded");
} catch (e) {
  console.log("âœ— ffmpeg not available");
}

// â”€â”€â”€ Express setup â”€â”€â”€

const app = express();
app.use(cors());
app.use(express.json());

// â”€â”€â”€ Spotify API (client-credentials flow, no user login) â”€â”€â”€

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

// â”€â”€â”€ Helper: download a file over HTTPS (for album art) â”€â”€â”€

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

// â”€â”€â”€ YouTube audio download (tries multiple methods) â”€â”€â”€

async function downloadYouTubeAudio(videoUrl, outputFile) {
  // Method 1: youtube-dl-exec (npm package that bundles yt-dlp binary)
  if (youtubedl) {
    try {
      console.log("Trying youtube-dl-exec...");
      await youtubedl(videoUrl, {
        extractAudio: true,
        audioFormat: "mp3",
        audioQuality: 0,
        output: outputFile,
        noPlaylist: true,
        noWarnings: true,
      });
      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        console.log("âœ“ youtube-dl-exec succeeded");
        return;
      }
    } catch (e) {
      console.log("âœ— youtube-dl-exec failed:", e.message);
    }
  }

  // Method 2: yt-dlp via child_process (if installed as system binary)
  try {
    console.log("Trying yt-dlp binary...");
    await execFileAsync("yt-dlp", [
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "-o", outputFile, "--no-playlist", "--no-warnings",
      videoUrl,
    ], { timeout: 120000 });
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log("âœ“ yt-dlp binary succeeded");
      return;
    }
  } catch (e) {
    console.log("âœ— yt-dlp binary failed:", e.message);
  }

  // Method 3: @distube/ytdl-core + fluent-ffmpeg (stream-based)
  if (ytdl && ffmpeg) {
    try {
      console.log("Trying ytdl-core + ffmpeg...");
      const audioStream = ytdl(videoUrl, {
        quality: "highestaudio",
        filter: "audioonly",
      });

      await new Promise((resolve, reject) => {
        ffmpeg(audioStream)
          .toFormat("mp3")
          .audioBitrate(320)
          .save(outputFile)
          .on("end", resolve)
          .on("error", reject);
      });

      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        console.log("âœ“ ytdl-core + ffmpeg succeeded");
        return;
      }
    } catch (e) {
      console.log("âœ— ytdl-core + ffmpeg failed:", e.message);
    }
  }

  throw new Error("All download methods failed");
}

// â”€â”€â”€ Helper: add metadata + album art to an MP3 file â”€â”€â”€

function tagMp3(inputFile, outputFile, metadata, artworkPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) {
      // No ffmpeg available â€” just copy the file as-is
      fs.copyFileSync(inputFile, outputFile);
      resolve();
      return;
    }

    let cmd = ffmpeg().input(inputFile);

    if (artworkPath && fs.existsSync(artworkPath)) {
      cmd = cmd.input(artworkPath);
    }

    const opts = [];
    if (artworkPath && fs.existsSync(artworkPath)) {
      opts.push("-map", "0:a", "-map", "1:v");
      opts.push("-c:v", "mjpeg");
      opts.push("-disposition:v:0", "attached_pic");
    }
    opts.push(
      "-metadata", `title=${metadata.title}`,
      "-metadata", `artist=${metadata.artist}`,
      "-metadata", `album=${metadata.album}`,
      "-metadata", `comment=Downloaded via SideCut`,
    );

    cmd
      .toFormat("mp3")
      .audioBitrate(320)
      .outputOptions(opts)
      .save(outputFile)
      .on("end", resolve)
      .on("error", reject);
  });
}

// â”€â”€â”€ Routes â”€â”€â”€

app.get("/", (req, res) => {
  res.send("SideCut backend is online!");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    spotify: !!process.env.SPOTIFY_CLIENT_ID,
  });
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

// â”€â”€â”€ /metadata â€” fetch real track info from Spotify â”€â”€â”€

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
        : "Failed to fetch metadata: " + error.message,
    });
  }
});

// â”€â”€â”€ /download â€” search YouTube, download audio, stream MP3 back â”€â”€â”€

app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  let artworkPath = null;
  let rawAudioFile = null;
  let taggedFile = null;

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
        error: "Only individual tracks are supported for download",
      });
    }

    // 1. Get track metadata from Spotify
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

    // 3. Download album art from Spotify (best-effort)
    if (artworkUrl) {
      try {
        artworkPath = `/tmp/artwork_${id}.jpg`;
        await downloadFile(artworkUrl, artworkPath);
        console.log("Album art downloaded");
      } catch (e) {
        console.warn("Album art failed:", e.message);
        artworkPath = null;
      }
    }

    // 4. Download audio from YouTube to a temp file
    rawAudioFile = `/tmp/sidecut_raw_${id}.mp3`;
    taggedFile = `/tmp/sidecut_tagged_${id}.mp3`;

    await downloadYouTubeAudio(video.url, rawAudioFile);
    console.log(`Audio downloaded: ${fs.statSync(rawAudioFile).size} bytes`);

    // 5. Add metadata + album art
    const metadata = { title: trackName, artist: artistName, album: albumName };

    try {
      await tagMp3(rawAudioFile, taggedFile, metadata, artworkPath);
      console.log("Metadata embedded");
    } catch (e) {
      console.warn("Tagging failed, using raw file:", e.message);
      fs.copyFileSync(rawAudioFile, taggedFile);
    }

    // 6. Stream the MP3 to the client
    const safeFileName = `${artistName} - ${trackName}`
      .replace(/[^\w\s\-]/g, "_")
      .trim();

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName}.mp3"`
    );

    const fileStream = fs.createReadStream(taggedFile);
    fileStream.pipe(res);

    fileStream.on("end", () => {
      cleanup(id);
    });

    fileStream.on("error", (err) => {
      console.error("Stream error:", err.message);
      cleanup(id);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Stream error" });
      }
    });

    // Clean up if client disconnects early
    req.on("close", () => {
      cleanup(id);
    });
  } catch (error) {
    console.error("Download error:", error.message);
    cleanup(id || "unknown");
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message.includes("Spotify credentials")
          ? "Server not configured with Spotify API credentials"
          : "Download failed: " + error.message,
      });
    }
  }

  function cleanup(trackId) {
    const files = [
      `/tmp/artwork_${trackId}.jpg`,
      `/tmp/sidecut_raw_${trackId}.mp3`,
      `/tmp/sidecut_tagged_${trackId}.mp3`,
    ];
    files.forEach((f) => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {}
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SideCut backend running on port ${PORT}`);
});
