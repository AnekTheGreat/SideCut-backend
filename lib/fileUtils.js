const fs = require("fs");
const https = require("https");

// Delete a file if it exists, swallowing any errors.
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

// A download is considered valid if the file exists and is larger than minSize bytes.
function isValidDownload(filePath, minSize = 1000) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > minSize;
  } catch (e) {
    return false;
  }
}

// Download a URL to a destination file, following redirects (capped) and
// rejecting on non-2xx responses so error bodies are never treated as success.
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fail = (err) => {
      file.close();
      safeUnlink(dest);
      reject(err);
    };
    file.on("error", fail);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          safeUnlink(dest);
          if (redirects >= 5) return reject(new Error(`Too many redirects downloading ${url}`));
          res.resume();
          downloadFile(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return fail(new Error(`Download failed for ${url}: HTTP ${res.statusCode}`));
        }
        res.on("error", fail);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(dest);
        });
      })
      .on("error", fail);
  });
}

module.exports = { safeUnlink, isValidDownload, downloadFile };
