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

// Download a URL to a destination file, following one level of redirects.
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          safeUnlink(dest);
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(dest);
        });
      })
      .on("error", (err) => {
        file.close();
        safeUnlink(dest);
        reject(err);
      });
  });
}

module.exports = { safeUnlink, isValidDownload, downloadFile };
