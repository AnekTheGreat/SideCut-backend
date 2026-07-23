const { execFile } = require("child_process");

// Run yt-dlp with the given args, always resolving with the result.
function runYtDlp(args, { ytDlpPath = "yt-dlp", timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(ytDlpPath, args, { timeout, maxBuffer: 1024 * 1024 * 50, cwd: "/tmp" }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err ? err.message : "") });
    });
  });
}

// Build the yt-dlp argument list for an audio extraction download.
function buildYtDlpArgs({ outputFile, extractorArgs, cookieFile, ffmpegPath, videoUrl }) {
  const args = [
    "-x", "--audio-format", "mp3", "--audio-quality", "5",
    "-o", outputFile, "--no-playlist", "--no-warnings", "--no-check-certificates",
    "--extractor-args", extractorArgs,
  ];
  if (cookieFile) args.push("--cookies", cookieFile);
  if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
  args.push(videoUrl);
  return args;
}

// Pull the first ERROR line out of yt-dlp stderr, falling back to a default.
function extractErrorLine(stderr, fallback = "failed") {
  return (stderr || "").split("\n").find((l) => l.includes("ERROR")) || fallback;
}

module.exports = { runYtDlp, buildYtDlpArgs, extractErrorLine };
