// Parse a Spotify link into its resource type and id, or null when it doesn't match.
function parseSpotifyUrl(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

// Join an array of artist objects into a comma-separated name string.
function joinArtists(artists) {
  return (artists || []).map((a) => a.name).join(", ");
}

// Return the URL of the first image in a Spotify images array, or an empty string.
function firstImageUrl(images) {
  return images?.[0]?.url || "";
}

// Build a Spotify search query for a song that lacks metadata. Accepts either a
// free-form `query`, or separate `title`/`artist` fields. Returns a trimmed
// query string, or null when there's nothing usable to search for.
function buildSearchQuery({ query, title, artist } = {}) {
  if (query && query.trim()) return query.trim();
  const parts = [];
  if (title && title.trim()) parts.push(title.trim());
  if (artist && artist.trim()) parts.push(artist.trim());
  const q = parts.join(" ").trim();
  return q || null;
}

// Map a Spotify track object into the flat metadata shape the app consumes.
function mapTrackToMetadata(track) {
  if (!track) return null;
  return {
    title: track.name,
    artist: joinArtists(track.artists),
    album: track.album?.name || "",
    artwork: firstImageUrl(track.album?.images),
    duration: track.duration_ms,
    trackNumber: track.track_number,
    releaseDate: track.album?.release_date || "",
    isrc: track.external_ids?.isrc || "",
    spotifyId: track.id,
    spotifyUrl: track.external_urls?.spotify || "",
  };
}

module.exports = { parseSpotifyUrl, joinArtists, firstImageUrl, buildSearchQuery, mapTrackToMetadata };
