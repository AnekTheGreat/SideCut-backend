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

// ─── Cookies: read from env var or file path ───
let cookieFilePath = null;
function getCookieFile() {
  if (cookieFilePath && fs.existsSync(cookieFilePath)) return cookieFilePath;
  
  if (process.env.YOUTUBE_COOKIE_FILE && fs.existsSync(process.env.YOUTUBE_COOKIE_FILE)) {
    cookieFilePath = process.env.YOUTUBE_COOKIE_FILE;
    console.log("✓ Using cookies from YOUTUBE_COOKIE_FILE:", cookieFilePath);
    return cookieFilePath;
  }
  
  if (process.env.YOUTUBE_COOKIES) {
    cookieFilePath = "/tmp/yt_cookies.txt";
    fs.writeFileSync(cookieFilePath, process.env.YOUTUBE_COOKIES);
    // Validate it looks like a Netscape cookie file
    const content = fs.readFileSync(cookieFilePath, "utf8");
    if (!content.includes(".youtube.com") && !content.includes(".google.com")) {
      console.log("⚠ Cookie file doesn't contain YouTube cookies — may not work");
    }
    console.log("✓ Using cookies from YOUTUBE_COOKIES env var");
    return cookieFilePath;
  }
  
  return null;
}

// ─── Download with system yt-dlp ───
// KEY FIX: When cookies are available, use 'web' client (sends cookies + extracts PO token from them)
//          When no cookies, use 'android_vr' client (doesn't need PO token, but bot detection may block)
async function downloadWithSystemYtDlp(videoUrl, outputFile, useCookies) {
  try {
    const args = [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile,
      "--no-playlist", "--no-warnings", "--no-check-certificates",
    ];
    
    if (useCookies) {
      const cookieFile = getCookieFile();
      if (cookieFile) {
        args.push("--cookies", cookieFile);
        // Use web client with cookies — this is the key fix
        args.push("--extractor-args", "youtube:player_client=web");
      } else {
        useCookies = false; // No cookie file, fall through to android_vr
      }
    }
    
    if (!useCookies) {
      // No cookies — use android_vr (doesn't need PO token)
      args.push("--extractor-args", "youtube:player_client=android_vr");
    }
    
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    
    console.log("Running: yt-dlp", args.join(" "));
    await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ yt-dlp succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: useCookies ? "yt-dlp+web+cookies" : "yt-dlp+android_vr" };
    }
    return { ok: false, method: "system-yt-dlp", error: "File too small or missing" };
  } catch (e) {
    console.log("✗ system yt-dlp failed:", String(e.message).substring(0, 300));
    return { ok: false, method: "system-yt-dlp", error: String(e.message).substring(0, 300) };
  }
}

// ─── Download with npm youtube-dl-exec ───
async function downloadWithNpmYtDlp(videoUrl, outputFile, useCookies) {
  if (!youtubedl) return { ok: false, method: "npm-yt-dlp", error: "package not loaded" };
  try {
    const opts = {
      extractAudio: true, audioFormat: "mp3", audioQuality: 5,
      output: outputFile, noPlaylist: true, noWarnings: true,
    };
    
    if (useCookies) {
      const cookieFile = getCookieFile();
      if (cookieFile) {
        opts.cookies = cookieFile;
        opts.extractorArgs = "youtube:player_client=web";
      } else {
        useCookies = false;
      }
    }
    
    if (!useCookies) {
      opts.extractorArgs = "youtube:player_client=android_vr";
    }
    
    if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
    await youtubedl(videoUrl, opts);
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ youtube-dl-exec succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: useCookies ? "npm-yt-dlp+web+cookies" : "npm-yt-dlp" };
    }
    return { ok: false, method: "npm-yt-dlp", error: "File too small or missing" };
  } catch (e) {
    console.log("✗ youtube-dl-exec failed:", String(e.message).substring(0, 300));
    return { ok: false, method: "npm-yt-dlp", error: String(e.message).substring(0, 300) };
  }
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
    } catch (e) {
      cookieInfo = "configured but error reading";
    }
  }
  
  res.json({
    youtube_dl_exec: !!youtubedl,
    ffmpeg: !!ffmpeg,
    ffmpeg_path: ffmpegPath,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    system_yt_dlp: ytDlpPath ? { path: ytDlpPath, version: ytDlpVersion } : null,
    cookies: cookieInfo,
    node_version: process.version,
    platform: process.platform,
  });
});

app.get("/test-download", async (req, res) => {
  const testUrl = "https://www.youtube.com/watch?v=4NRXx6U8ABQ";
  const testFile = "/tmp/sidecut_test.mp3";
  const results = [];
  const hasCookies = !!getCookieFile();
  
  // Method 1: yt-dlp with cookies + web client (the key fix)
  if (hasCookies) {
    const r = await downloadWithSystemYtDlp(testUrl, testFile, true);
    results.push(r);
    if (r.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  }
  
  // Method 2: yt-dlp with android_vr (no cookies)
  const r1 = await downloadWithSystemYtDlp(testUrl, testFile, false);
  results.push(r1);
  if (r1.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  // Method 3: npm youtube-dl-exec with cookies + web client
  if (hasCookies) {
    const r2 = await downloadWithNpmYtDlp(testUrl, testFile, true);
    results.push(r2);
    if (r2.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  }
  
  // Method 4: npm youtube-dl-exec with android_vr
  const r3 = await downloadWithNpmYtDlp(testUrl, testFile, false);
  results.push(r3);
  if (r3.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  res.json({ 
    success: false, 
    results,
    hint: hasCookies 
      ? "Cookies are configured but download still failed with web client. Cookies may be expired or malformed. Check /debug for cookie info. Re-export fresh cookies from your browser."
      : "No cookies configured. Set YOUTUBE_COOKIES env var with your YouTube cookies (Netscape format). Install 'Get cookies.txt LOCALLY' browser extension, visit youtube.com, export cookies."
  });
});

// ─── /metadata (supports track, album, playlist) ───
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
      const tracks = d.tracks.items.map(t => ({
        title: t.name,
        artist: t.artists.map(a => a.name).join(", "),
        duration: t.duration_ms,
        trackNumber: t.track_number,
        spotifyUrl: t.external_urls?.spotify || "",
        spotifyId: t.id,
      }));
      res.json({ success: true, type, id, title: d.name, artist: d.artists.map((a) => a.name).join(", "), album: d.name, artwork: d.images[0]?.url || "", trackCount: d.tracks.items.length, tracks, url });
    } else if (type === "playlist") {
      const d = (await spotifyApi.getPlaylist(id)).body;
      const tracks = d.tracks.items.filter(item => item.track).map(item => ({
        title: item.track.name,
        artist: item.track.artists.map(a => a.name).join(", "),
        album: item.track.album?.name || "",
        duration: item.track.duration_ms,
        spotifyUrl: item.track.external_urls?.spotify || "",
        spotifyId: item.track.id,
        artwork: item.track.album?.images?.[0]?.url || "",
      }));
      res.json({ success: true, type, id, title: d.name, artist: d.owner?.display_name || "Various Artists", album: d.name, artwork: d.images[0]?.url || "", trackCount: tracks.length, tracks, url });
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
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks are supported. For albums/playlists, use /metadata to get the track list." });

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

    // 4. Download audio
    rawFile = `/tmp/sidecut_raw_${id}_${Date.now()}.mp3`;
    tempFiles.push(rawFile);
    const hasCookies = !!getCookieFile();
    const allResults = [];
    let downloadResult = null;
    
    // Method 1: yt-dlp with cookies + web client (key fix)
    if (hasCookies) {
      downloadResult = await downloadWithSystemYtDlp(video.url, rawFile, true);
      allResults.push(downloadResult);
    }
    
    // Method 2: yt-dlp with android_vr (no cookies)
    if (!downloadResult?.ok) {
      downloadResult = await downloadWithSystemYtDlp(video.url, rawFile, false);
      allResults.push(downloadResult);
    }
    
    // Method 3: npm youtube-dl-exec with cookies + web client
    if (!downloadResult?.ok && hasCookies) {
      downloadResult = await downloadWithNpmYtDlp(video.url, rawFile, true);
      allResults.push(downloadResult);
    }
    
    // Method 4: npm youtube-dl-exec with android_vr
    if (!downloadResult?.ok) {
      downloadResult = await downloadWithNpmYtDlp(video.url, rawFile, false);
      allResults.push(downloadResult);
    }
    
    if (!downloadResult?.ok) {
      const errors = allResults.map(r => `[${r.method}]: ${r.error}`).join(" | ");
      const hint = hasCookies 
        ? "Cookies are configured but the web client download failed. Your cookies may be expired or in the wrong format. Check /debug for cookie details. Re-export fresh cookies from youtube.com using 'Get cookies.txt LOCALLY' extension."
        : "YouTube is blocking this server's IP. Add YouTube cookies: install 'Get cookies.txt LOCALLY' browser extension, visit youtube.com while logged in, export cookies, set as YOUTUBE_COOKIES env var in Render.";
      return res.status(502).json({ 
        success: false, 
        error: `Download failed. ${errors}`,
        hint,
        video: { title: video.title, url: video.url, id: video.videoId }
      });
    }

    console.log(`Downloaded via ${downloadResult.method}: ${fs.statSync(rawFile).size} bytes`);

    // 5. Tag with metadata + artwork
    taggedFile = `/tmp/sidecut_tagged_${id}_${Date.now()}.mp3`;
    tempFiles.push(taggedFile);
    try {
      await tagMp3(rawFile, taggedFile, { title: trackName, artist: artistName, album: albumName }, artworkPath);
    } catch (e) {
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
