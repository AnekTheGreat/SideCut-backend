const fs = require("fs");

// Env vars set through some dashboards flatten newlines/tabs into the literal
// characters "\n"/"\t", which produces a cookie file yt-dlp can't parse. If the
// value has no real newlines but does contain escaped ones, un-escape them, and
// ensure the Netscape header and a trailing newline are present.
function normalizeCookies(raw) {
  let s = raw;
  if (!s.includes("\n") && s.includes("\\n")) {
    s = s.replace(/\\t/g, "\t").replace(/\\r/g, "").replace(/\\n/g, "\n");
  }
  if (!/^#/.test(s.trimStart())) s = "# Netscape HTTP Cookie File\n" + s;
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

// Report on a cookie file without exposing any secret values, so /debug can tell
// whether the configured cookies are valid and authenticated.
function analyzeCookieFile(filePath) {
  if (!filePath) return { configured: false };
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return { configured: true, readable: false };
  }
  const cookieLines = content
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  // Netscape format columns: domain, flag, path, secure, expiry, name, value.
  const names = cookieLines.map((l) => l.split("\t")[5]).filter(Boolean);
  const authNames = ["SID", "SAPISID", "__Secure-3PSID", "__Secure-1PSID", "LOGIN_INFO", "HSID", "SSID"];
  const presentAuth = authNames.filter((n) => names.includes(n));
  return {
    configured: true,
    readable: true,
    hasNetscapeHeader: /^#\s*Netscape HTTP Cookie File/i.test(content.trimStart()),
    looksTabDelimited: cookieLines.some((l) => l.includes("\t")),
    totalCookies: cookieLines.length,
    authCookiesPresent: presentAuth,
    isAuthenticated: presentAuth.length > 0,
  };
}

module.exports = { normalizeCookies, analyzeCookieFile };
