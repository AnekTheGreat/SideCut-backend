const fs = require("fs");

// Convert a browser-extension JSON cookie export (array of cookie objects, as
// produced by "Get cookies.txt"/EditThisCookie) into the Netscape cookies.txt
// format yt-dlp expects. Returns null if the input isn't such a JSON array.
function jsonCookiesToNetscape(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const arr = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null;
  if (!arr || !arr.every((c) => c && typeof c.name === "string" && typeof c.domain === "string")) {
    return null;
  }
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of arr) {
    const includeSub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = c.session || c.expirationDate == null ? 0 : Math.floor(c.expirationDate);
    lines.push([c.domain, includeSub, c.path || "/", secure, expiry, c.name, c.value == null ? "" : c.value].join("\t"));
  }
  return lines.join("\n") + "\n";
}

// Normalize a YOUTUBE_COOKIES value into a valid Netscape cookies.txt string.
// Handles three real-world cases: a JSON export (converted), a value whose
// newlines/tabs were flattened to literal "\n"/"\t" by a dashboard env var
// (un-escaped), and an already-valid file (header/trailing newline ensured).
function normalizeCookies(raw) {
  const asJson = jsonCookiesToNetscape(raw.trimStart());
  if (asJson) return asJson;
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

module.exports = { normalizeCookies, jsonCookiesToNetscape, analyzeCookieFile };
