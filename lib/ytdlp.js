const { execFile } = require("child_process");

// Run yt-dlp with the given args, always resolving with the result.
function runYtDlp(args, { ytDlpPath = "yt-dlp", timeout = 120000 } = {}) {
  // Route all yt-dlp traffic through a proxy when configured. A residential
  // proxy is the most effective way to bypass YouTube's datacenter-IP bot
  // check on hosts like Render.
  if (process.env.YOUTUBE_PROXY) {
    args = ["--proxy", process.env.YOUTUBE_PROXY, ...args];
  }
  
  // Log the command being run (useful for debugging)
  const cmdStr = `${ytDlpPath} ${args.join(" ")}`;
  if (process.env.DEBUG_YTDL) {
    console.log("[YT-DLP] Running:", cmdStr);
  }
  
  return new Promise((resolve) => {
    execFile(ytDlpPath, args, { timeout, maxBuffer: 1024 * 1024 * 50, cwd: "/tmp" }, (err, stdout, stderr) => {
      const output = {
        ok: !err,
        stdout: stdout || "",
        stderr: stderr || (err ? err.message : ""),
      };
      
      // Log success/failure
      if (process.env.DEBUG_YTDL) {
        console.log("[YT-DLP] Result:", output.ok ? "SUCCESS" : "FAILED");
        if (!output.ok && stderr) {
          const errorLine = (stderr || "").split("\n").find(l => l.includes("ERROR")) || stderr.substring(0, 300);
          console.log("[YT-DLP] Error:", errorLine);
        }
      }
      
      resolve(output);
    });
  });
}

// Build the yt-dlp argument list for an audio extraction download.
function buildYtDlpArgs({ outputFile, extractorArgs, cookieFile, ffmpegPath, videoUrl, useProxy = false }) {
  const args = [
    "-x", "--audio-format", "mp3", "--audio-quality", "5",
    "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates",
  ];
  
  if (extractorArgs) {
    args.push("--extractor-args", extractorArgs);
  }
  
  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }
  
  if (ffmpegPath) {
    args.push("--ffmpeg-location", ffmpegPath);
  }
  
  // Add user agent to appear more like a real browser
  args.push("--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  
  // Add geo bypass options
  args.push("--geo-bypass", "--geo-bypass-country", "US");
  
  args.push(videoUrl);
  return args;
}

// Pull the first ERROR line out of yt-dlp stderr, falling back to a default.
function extractErrorLine(stderr, fallback = "failed") {
  const lines = (stderr || "").split("\n");
  const errorLine = lines.find((l) => l.includes("ERROR"));
  if (errorLine) {
    // Clean up the error message
    return errorLine.replace(/^\[ERROR\] /, "").trim() || fallback;
  }
  // Also check for other common failure patterns
  const warningLine = lines.find(l => 
    l.includes("This video is available only to Premium members") ||
    l.includes("Video unavailable") ||
    l.includes("Sign in to confirm your age") ||
    l.includes("HTTP Error 403") ||
    l.includes("HTTP Error 429")
  );
  if (warningLine) {
    return warningLine.trim();
  }
  return fallback;
}

module.exports = { runYtDlp, buildYtDlpArgs, extractErrorLine };
