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

module.exports = { parseSpotifyUrl, joinArtists, firstImageUrl };
