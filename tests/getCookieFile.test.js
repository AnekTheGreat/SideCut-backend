const fs = require("fs");
const os = require("os");
const path = require("path");

describe("getCookieFile", () => {
  let tmpDir;
  const savedEnv = {};
  const ENV_KEYS = ["YOUTUBE_COOKIE_FILE", "YOUTUBE_COOKIES"];

  beforeEach(() => {
    // server.js caches the resolved cookie path in a module-level variable,
    // so reset the module registry to get a clean state for each test.
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecut-cookie-"));
    ENV_KEYS.forEach((k) => {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no cookie env vars are set", () => {
    const { getCookieFile } = require("../server");
    expect(getCookieFile()).toBeNull();
  });

  test("returns YOUTUBE_COOKIE_FILE when the file exists", () => {
    const cookieFile = path.join(tmpDir, "cookies.txt");
    fs.writeFileSync(cookieFile, "# Netscape HTTP Cookie File");
    process.env.YOUTUBE_COOKIE_FILE = cookieFile;

    const { getCookieFile } = require("../server");
    expect(getCookieFile()).toBe(cookieFile);
  });

  test("ignores YOUTUBE_COOKIE_FILE when the file does not exist", () => {
    process.env.YOUTUBE_COOKIE_FILE = path.join(tmpDir, "missing.txt");

    const { getCookieFile } = require("../server");
    expect(getCookieFile()).toBeNull();
  });

  test("writes YOUTUBE_COOKIES contents to a file and returns its path", () => {
    process.env.YOUTUBE_COOKIES = "cookie-data-here";

    const { getCookieFile } = require("../server");
    const result = getCookieFile();
    expect(result).toBe("/tmp/yt_cookies.txt");
    // Contents are normalized (Netscape header prepended) but preserve the data.
    expect(fs.readFileSync(result, "utf8")).toContain("cookie-data-here");
  });

  test("caches the resolved path across calls", () => {
    const cookieFile = path.join(tmpDir, "cookies.txt");
    fs.writeFileSync(cookieFile, "data");
    process.env.YOUTUBE_COOKIE_FILE = cookieFile;

    const { getCookieFile } = require("../server");
    const first = getCookieFile();
    // Remove the env var; a cached, still-existing path should be returned.
    delete process.env.YOUTUBE_COOKIE_FILE;
    expect(getCookieFile()).toBe(first);
  });
});
