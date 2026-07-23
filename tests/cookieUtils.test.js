const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeCookies, jsonCookiesToNetscape, analyzeCookieFile } = require("../lib/cookieUtils");

describe("jsonCookiesToNetscape", () => {
  test("converts a JSON cookie export into Netscape format", () => {
    const json = JSON.stringify([
      { domain: ".youtube.com", name: "SID", value: "aaa", path: "/", secure: false, expirationDate: 1819306413.9 },
      { domain: ".youtube.com", name: "YSC", value: "ccc", path: "/", secure: true, session: true },
    ]);
    const out = jsonCookiesToNetscape(json);
    expect(out.startsWith("# Netscape HTTP Cookie File")).toBe(true);
    expect(out).toContain(".youtube.com\tTRUE\t/\tFALSE\t1819306413\tSID\taaa");
    // session cookies get expiry 0
    expect(out).toContain(".youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tccc");
  });

  test("supports host-only (no leading dot) domains", () => {
    const out = jsonCookiesToNetscape(
      JSON.stringify([{ domain: "youtube.com", name: "X", value: "1", secure: false, session: true }])
    );
    expect(out).toContain("youtube.com\tFALSE\t/\tFALSE\t0\tX\t1");
  });

  test("returns null for non-JSON input", () => {
    expect(jsonCookiesToNetscape("# Netscape HTTP Cookie File\n")).toBeNull();
  });

  test("returns null for JSON that isn't a cookie array", () => {
    expect(jsonCookiesToNetscape('{"foo":"bar"}')).toBeNull();
    expect(jsonCookiesToNetscape('[{"nope":1}]')).toBeNull();
  });
});

describe("normalizeCookies with JSON input", () => {
  test("detects and converts a JSON export", () => {
    const json = JSON.stringify([
      { domain: ".youtube.com", name: "SAPISID", value: "bbb", path: "/", secure: true, expirationDate: 1815513081.1 },
    ]);
    const out = normalizeCookies(json);
    expect(out).toContain("\tSAPISID\tbbb");
    expect(out).not.toContain("{");
  });
});

describe("normalizeCookies", () => {
  test("adds a Netscape header when missing", () => {
    const out = normalizeCookies(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tval");
    expect(out.startsWith("# Netscape HTTP Cookie File")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("keeps an existing header", () => {
    const raw = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tval\n";
    expect(normalizeCookies(raw).match(/# Netscape HTTP Cookie File/g)).toHaveLength(1);
  });

  test("un-escapes literal \\n and \\t when there are no real newlines", () => {
    const raw =
      "# Netscape HTTP Cookie File\\n.youtube.com\\tTRUE\\t/\\tTRUE\\t0\\tSID\\tval";
    const out = normalizeCookies(raw);
    expect(out).toContain("\n");
    expect(out).toContain("\t");
    expect(out).not.toContain("\\n");
    expect(out).not.toContain("\\t");
  });

  test("leaves already-valid multiline content untouched", () => {
    const raw = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tval\n";
    expect(normalizeCookies(raw)).toBe(raw);
  });
});

describe("analyzeCookieFile", () => {
  let tmpFile;

  afterEach(() => {
    if (tmpFile) fs.rmSync(tmpFile, { force: true });
    tmpFile = null;
  });

  test("returns not configured for a falsy path", () => {
    expect(analyzeCookieFile(null)).toEqual({ configured: false });
  });

  test("detects an authenticated, well-formed cookie file", () => {
    tmpFile = path.join(os.tmpdir(), `ck-${Date.now()}.txt`);
    fs.writeFileSync(
      tmpFile,
      "# Netscape HTTP Cookie File\n" +
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n" +
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\txyz\n" +
        ".youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO\tqq\n"
    );
    const r = analyzeCookieFile(tmpFile);
    expect(r).toMatchObject({
      configured: true,
      readable: true,
      hasNetscapeHeader: true,
      looksTabDelimited: true,
      totalCookies: 3,
      isAuthenticated: true,
    });
    expect(r.authCookiesPresent).toEqual(expect.arrayContaining(["SID", "SAPISID"]));
  });

  test("flags a file with no auth cookies as unauthenticated", () => {
    tmpFile = path.join(os.tmpdir(), `ck-${Date.now()}-2.txt`);
    fs.writeFileSync(
      tmpFile,
      "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO\tqq\n"
    );
    const r = analyzeCookieFile(tmpFile);
    expect(r.isAuthenticated).toBe(false);
    expect(r.authCookiesPresent).toEqual([]);
  });
});
