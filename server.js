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
let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegPath = require("ffmpeg-static");
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("✓ ffmpeg-static loaded:", ffmpegPath);
} catch (e) { console.log("✗ ffmpeg not available"); }
let puppeteer = null;
try { puppeteer = require("puppeteer"); console.log("✓ puppeteer loaded"); } catch (e) { console.log("✗ puppeteer not available — browser method disabled"); }

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

// ─── Generate YouTube cookies using Puppeteer (real browser bypasses bot detection) ───
let cachedCookies = null;
let cookieExpiry = 0;
async function getYoutubeCookies() {
  if (!puppeteer) return null;
  // Cache cookies for 30 minutes
  if (cachedCookies && Date.now() < cookieExpiry) {
    console.log("Using cached YouTube cookies");
    return cachedCookies;
  }
  
  try {
    console.log("Generating YouTube cookies via Puppeteer...");
    const browser = await puppeteer.launch({
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--single-process",
      ],
      headless: "new",
      timeout: 30000,
    });
    
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    
    // Visit YouTube — this runs BotGuard and sets session cookies
    await page.goto("https://www.youtube.com/", { waitUntil: "networkidle2", timeout: 30000 });
    
    // Wait a bit for JavaScript to execute (BotGuard challenge)
    await page.waitForTimeout(3000);
    
    // Export cookies in Netscape format (what yt-dlp expects)
    const cookies = await page.cookies();
    const cookieFile = `/tmp/yt_cookies_${Date.now()}.txt`;
    let cookieText = "# Netscape HTTP Cookie File\n";
    for (const c of cookies) {
      const secure = c.secure ? "TRUE" : "FALSE";
      const httpOnly = c.httpOnly ? "TRUE" : "FALSE";
      const expiry = c.expires > 0 ? Math.floor(c.expires) : "0";
      cookieText += `${c.httpOnly ? "#HttpOnly_" : ""}${c.domain}\tTRUE\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
    }
    fs.writeFileSync(cookieFile, cookieText);
    
    await browser.close();
    console.log(`✓ Generated ${cookies.length} cookies`);
    
    cachedCookies = cookieFile;
    cookieExpiry = Date.now() + 30 * 60 * 1000; // 30 minutes
    return cookieFile;
  } catch (e) {
    console.log("✗ Puppeteer cookie generation failed:", e.message);
    return null;
  }
}

// ─── Extract audio URL from YouTube page using Puppeteer ───
async function getAudioUrlWithBrowser(videoId) {
  if (!puppeteer) return null;
  try {
    console.log(`Extracting audio URL via Puppeteer for ${videoId}...`);
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
      headless: "new",
      timeout: 30000,
    });
    
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Extract ytInitialPlayerResponse from the page
    const playerResponse = await page.evaluate(() => {
      return window.ytInitialPlayerResponse;
    });
    
    await browser.close();
    
    if (!playerResponse || !playerResponse.streamingData) {
      console.log("✗ No player response in page");
      return null;
    }
    
    const formats = playerResponse.streamingData.adaptiveFormats || [];
    const audioFormats = formats.filter(f => f.mimeType && f.mimeType.includes("audio"));
    
    if (audioFormats.length === 0) {
      console.log("✗ No audio formats in page player response");
      return null;
    }
    
    const best = audioFormats.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a);
    console.log(`✓ Got audio URL from browser: ${best.mimeType} ${best.bitrate}bps`);
    return { url: best.url, mimeType: best.mimeType };
  } catch (e) {
    console.log("✗ Puppeteer URL extraction failed:", e.message);
    return null;
  }
}

// ─── Download audio using system yt-dlp ───
async function downloadWithSystemYtDlp(videoUrl, outputFile, cookiesFile) {
  try {
    const args = [
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outputFile,
      "--no-playlist", "--no-warnings", "--no-check-certificates",
      "--extractor-args", "youtube:player_client=android_vr",
    ];
    if (cookiesFile) { args.push("--cookies", cookiesFile); }
    if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
    args.push(videoUrl);
    
    console.log("Running: yt-dlp", args.join(" "));
    await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ yt-dlp succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: cookiesFile ? "yt-dlp+cookies" : "yt-dlp+android_vr" };
    }
    return { ok: false, method: "system-yt-dlp", error: "File too small or missing" };
  } catch (e) {
    console.log("✗ system yt-dlp failed:", e.message);
    return { ok: false, method: "system-yt-dlp", error: e.message };
  }
}

// ─── Download audio using npm youtube-dl-exec ───
async function downloadWithNpmYtDlp(videoUrl, outputFile, cookiesFile) {
  if (!youtubedl) return { ok: false, method: "npm-yt-dlp", error: "package not loaded" };
  try {
    const opts = {
      extractAudio: true, audioFormat: "mp3", audioQuality: 5,
      output: outputFile, noPlaylist: true, noWarnings: true,
      extractorArgs: "youtube:player_client=android_vr",
    };
    if (cookiesFile) opts.cookies = cookiesFile;
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

// ─── Download audio from direct URL (from Puppeteer extraction) ───
async function downloadFromUrl(audioUrl, outputFile) {
  try {
    const rawFile = outputFile.replace(/\.mp3$/, ".webm");
    const file = fs.createWriteStream(rawFile);
    await new Promise((resolve, reject) => {
      https.get(audioUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    });
    
    if (!fs.existsSync(rawFile) || fs.statSync(rawFile).size < 1000) {
      return { ok: false, method: "browser-url", error: "Download too small" };
    }
    
    // Convert to MP3 with ffmpeg
    if (ffmpeg && ffmpegPath) {
      await new Promise((resolve, reject) => {
        ffmpeg().input(rawFile).toFormat("mp3").audioBitrate(192).save(outputFile)
          .on("end", resolve).on("error", reject);
      });
      try { fs.unlinkSync(rawFile); } catch (e) {}
    } else {
      fs.renameSync(rawFile, outputFile);
    }
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      console.log(`✓ Browser URL download succeeded: ${fs.statSync(outputFile).size} bytes`);
      return { ok: true, method: "browser-url" };
    }
    return { ok: false, method: "browser-url", error: "Conversion failed" };
  } catch (e) {
    console.log("✗ Browser URL download failed:", e.message);
    return { ok: false, method: "browser-url", error: e.message };
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
  let ytDlpVersion = null, ytDlpPath = null;
  try {
    const result = await execFileAsync("which", ["yt-dlp"], { timeout: 5000 });
    ytDlpPath = result.stdout.trim();
    const versionResult = await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    ytDlpVersion = versionResult.stdout.trim();
  } catch (e) { ytDlpPath = null; }
  
  res.json({
    youtube_dl_exec: !!youtubedl,
    ffmpeg: !!ffmpeg,
    ffmpeg_path: ffmpegPath,
    puppeteer: !!puppeteer,
    spotify_client_id_set: !!process.env.SPOTIFY_CLIENT_ID,
    spotify_client_secret_set: !!process.env.SPOTIFY_CLIENT_SECRET,
    system_yt_dlp: ytDlpPath ? { path: ytDlpPath, version: ytDlpVersion } : null,
    node_version: process.version,
    platform: process.platform,
  });
});

// Diagnostic endpoint
app.get("/test-download", async (req, res) => {
  const testVideoId = "4NRXx6U8ABQ"; // Blinding Lights (was failing)
  const testUrl = `https://www.youtube.com/watch?v=${testVideoId}`;
  const testFile = `/tmp/sidecut_test_${Date.now()}.mp3`;
  const results = [];
  
  // Method 0: Generate cookies with Puppeteer, then use yt-dlp
  if (puppeteer) {
    const cookies = await getYoutubeCookies();
    if (cookies) {
      const r = await downloadWithSystemYtDlp(testUrl, testFile, cookies);
      results.push(r);
      if (r.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
    }
    
    // Method 0b: Extract audio URL from browser, download directly
    const audioInfo = await getAudioUrlWithBrowser(testVideoId);
    if (audioInfo) {
      const r = await downloadFromUrl(audioInfo.url, testFile);
      results.push(r);
      if (r.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
    }
  }
  
  // Method 1: system yt-dlp with android_vr (no cookies)
  const r1 = await downloadWithSystemYtDlp(testUrl, testFile, null);
  results.push(r1);
  if (r1.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  // Method 2: npm youtube-dl-exec
  const r2 = await downloadWithNpmYtDlp(testUrl, testFile, null);
  results.push(r2);
  if (r2.ok) { try { fs.unlinkSync(testFile); } catch(e) {} return res.json({ success: true, results }); }
  
  res.json({ success: false, results });
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
      const tracks = d.tracks.items.map(item => ({
        title: item.track.name,
        artist: item.track.artists.map(a => a.name).join(", "),
        album: item.track.album?.name || "",
        duration: item.track.duration_ms,
        spotifyUrl: item.track.external_urls?.spotify || "",
        spotifyId: item.track.id,
        artwork: item.track.album?.images?.[0]?.url || "",
      }));
      res.json({ success: true, type, id, title: d.name, artist: d.owner?.display_name || "Various Artists", album: d.name, artwork: d.images[0]?.url || "", trackCount: d.tracks.items.length, tracks, url });
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
    if (type !== "track") return res.status(400).json({ success: false, error: "Only individual tracks are supported for /download. For albums/playlists, use /metadata to get track list, then call /download for each track." });

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

    // 4. Download audio — try multiple methods
    rawFile = `/tmp/sidecut_raw_${id}_${Date.now()}.mp3`;
    tempFiles.push(rawFile);
    
    let downloadResult = null;
    
    // METHOD A: Generate cookies with Puppeteer, then use yt-dlp with cookies
    if (puppeteer) {
      const cookies = await getYoutubeCookies();
      if (cookies) {
        downloadResult = await downloadWithSystemYtDlp(video.url, rawFile, cookies);
        if (downloadResult.ok) {
          // If cookies worked, we can skip other methods
        }
      }
    }
    
    // METHOD B: Extract audio URL from browser page, download directly
    if (!downloadResult?.ok && puppeteer) {
      const audioInfo = await getAudioUrlWithBrowser(videoId);
      if (audioInfo) {
        downloadResult = await downloadFromUrl(audioInfo.url, rawFile);
      }
    }
    
    // METHOD C: System yt-dlp with android_vr (no cookies)
    if (!downloadResult?.ok) {
      downloadResult = await downloadWithSystemYtDlp(video.url, rawFile, null);
    }
    
    // METHOD D: npm youtube-dl-exec with android_vr
    if (!downloadResult?.ok) {
      downloadResult = await downloadWithNpmYtDlp(video.url, rawFile, null);
    }
    
    if (!downloadResult?.ok) {
      const errors = [downloadResult].map(r => `${r.method}: ${r.error}`).join("; ");
      return res.status(502).json({ 
        success: false, 
        error: `Download failed. ${errors}`,
        video: { title: video.title, url: video.url, id: videoId }
      });
    }

    console.log(`Downloaded via ${downloadResult.method}: ${fs.statSync(rawFile).size} bytes`);

    // 5. Add metadata + album art
    taggedFile = `/tmp/sidecut_tagged_${id}_${Date.now()}.mp3`;
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
