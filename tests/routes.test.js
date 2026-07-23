const request = require("supertest");

// Ensure Spotify credentials are unset so ensureSpotifyToken throws the
// "not configured" error rather than attempting a real network call.
delete process.env.SPOTIFY_CLIENT_ID;
delete process.env.SPOTIFY_CLIENT_SECRET;

const { app } = require("../server");

describe("GET /", () => {
  test("returns the online message", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("SideCut backend is online!");
  });
});

describe("GET /health", () => {
  test("returns a status payload", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(res.body).toHaveProperty("spotify");
    expect(res.body).toHaveProperty("cookies");
    expect(res.body).toHaveProperty("po_token");
    expect(res.body).toHaveProperty("provider_running");
    // No Spotify creds configured in the test env.
    expect(res.body.spotify).toBe(false);
  });
});

describe("POST /metadata", () => {
  test("400 when no URL is provided", async () => {
    const res = await request(app).post("/metadata").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "No URL provided" });
  });

  test("400 for a non-spotify URL", async () => {
    const res = await request(app)
      .post("/metadata")
      .send({ url: "https://youtube.com/watch?v=abc" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Invalid Spotify link" });
  });

  test("500 when Spotify credentials are not configured", async () => {
    const res = await request(app)
      .post("/metadata")
      .send({ url: "https://open.spotify.com/track/abc123" });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Spotify credentials not configured/);
  });
});

describe("POST /search-metadata", () => {
  test("400 when no query/title/items provided", async () => {
    const res = await request(app).post("/search-metadata").send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Provide query, title, or items/);
  });

  test("400 when batch exceeds the item limit", async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ query: `song ${i}` }));
    const res = await request(app).post("/search-metadata").send({ items });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Too many items/);
  });

  test("500 when Spotify credentials are not configured", async () => {
    const res = await request(app).post("/search-metadata").send({ query: "daft punk" });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Spotify credentials not configured/);
  });
});

describe("POST /download", () => {
  test("400 when no URL is provided", async () => {
    const res = await request(app).post("/download").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "No URL provided" });
  });

  test("400 for a non-spotify URL", async () => {
    const res = await request(app)
      .post("/download")
      .send({ url: "not-a-spotify-link" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Invalid Spotify link" });
  });

  test("400 for album URLs (only tracks supported)", async () => {
    const res = await request(app)
      .post("/download")
      .send({ url: "https://open.spotify.com/album/abc123" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: "Only individual tracks supported.",
    });
  });

  test("400 for playlist URLs (only tracks supported)", async () => {
    const res = await request(app)
      .post("/download")
      .send({ url: "https://open.spotify.com/playlist/abc123" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: "Only individual tracks supported.",
    });
  });

  test("500 for a track URL when Spotify credentials are not configured", async () => {
    const res = await request(app)
      .post("/download")
      .send({ url: "https://open.spotify.com/track/abc123" });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Download failed: Spotify credentials not configured/);
  });
});
