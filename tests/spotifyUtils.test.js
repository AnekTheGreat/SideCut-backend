const { buildSearchQuery, mapTrackToMetadata } = require("../lib/spotifyUtils");

describe("buildSearchQuery", () => {
  test("uses a free-form query when provided", () => {
    expect(buildSearchQuery({ query: "  one more time  " })).toBe("one more time");
  });

  test("combines title and artist", () => {
    expect(buildSearchQuery({ title: "Around the World", artist: "Daft Punk" })).toBe(
      "Around the World Daft Punk"
    );
  });

  test("works with only a title", () => {
    expect(buildSearchQuery({ title: "Digital Love" })).toBe("Digital Love");
  });

  test("returns null when there is nothing to search for", () => {
    expect(buildSearchQuery({})).toBeNull();
    expect(buildSearchQuery({ title: "   ", artist: "" })).toBeNull();
    expect(buildSearchQuery()).toBeNull();
  });
});

describe("mapTrackToMetadata", () => {
  test("maps a Spotify track into the flat metadata shape", () => {
    const track = {
      id: "trk1",
      name: "Harder Better Faster Stronger",
      duration_ms: 224000,
      track_number: 8,
      artists: [{ name: "Daft Punk" }],
      album: {
        name: "Discovery",
        release_date: "2001-03-12",
        images: [{ url: "https://img/cover.jpg" }, { url: "https://img/small.jpg" }],
      },
      external_ids: { isrc: "GBDUW0000059" },
      external_urls: { spotify: "https://open.spotify.com/track/trk1" },
    };
    expect(mapTrackToMetadata(track)).toEqual({
      title: "Harder Better Faster Stronger",
      artist: "Daft Punk",
      album: "Discovery",
      artwork: "https://img/cover.jpg",
      duration: 224000,
      trackNumber: 8,
      releaseDate: "2001-03-12",
      isrc: "GBDUW0000059",
      spotifyId: "trk1",
      spotifyUrl: "https://open.spotify.com/track/trk1",
    });
  });

  test("returns null for a missing track", () => {
    expect(mapTrackToMetadata(null)).toBeNull();
  });

  test("tolerates missing album/artist/id fields", () => {
    expect(mapTrackToMetadata({ name: "X" })).toEqual({
      title: "X",
      artist: "",
      album: "",
      artwork: "",
      duration: undefined,
      trackNumber: undefined,
      releaseDate: "",
      isrc: "",
      spotifyId: undefined,
      spotifyUrl: "",
    });
  });
});
