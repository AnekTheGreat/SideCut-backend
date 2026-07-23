const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeCookies, analyzeCookieFile } = require("../lib/cookieUtils");

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
