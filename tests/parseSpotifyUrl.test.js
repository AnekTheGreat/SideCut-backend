const { parseSpotifyUrl } = require("../server");

describe("parseSpotifyUrl", () => {
  test("parses a track URL", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/track/abc123XYZ")).toEqual({
      type: "track",
      id: "abc123XYZ",
    });
  });

  test("parses an album URL", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/album/Album99")).toEqual({
      type: "album",
      id: "Album99",
    });
  });

  test("parses a playlist URL", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/playlist/PL01")).toEqual({
      type: "playlist",
      id: "PL01",
    });
  });

  test("parses a URL with query params, ignoring the query string", () => {
    expect(
      parseSpotifyUrl("https://open.spotify.com/track/trackId?si=xyz")
    ).toEqual({ type: "track", id: "trackId" });
  });

  test("returns null for a non-spotify URL", () => {
    expect(parseSpotifyUrl("https://youtube.com/watch?v=abc")).toBeNull();
  });

  test("returns null for an unsupported spotify resource type", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/artist/xyz")).toBeNull();
  });

  test("returns null for empty, null, and non-string input", () => {
    expect(parseSpotifyUrl("")).toBeNull();
    expect(parseSpotifyUrl(null)).toBeNull();
    expect(parseSpotifyUrl(undefined)).toBeNull();
    expect(parseSpotifyUrl(12345)).toBeNull();
    expect(parseSpotifyUrl({})).toBeNull();
  });
});
