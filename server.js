const express = require("express");
const cors = require("cors");
const SpotifyWebApi = require("spotify-web-api-node");

const app = express();

app.use(cors());
app.use(express.json());

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

app.get("/", (req, res) => {
    res.send("SideCut backend is online!");
});

app.post("/spotify-metadata", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "No Spotify URL provided"
        });
    }

    try {
        // Get Spotify access token
        await spotifyApi.clientCredentialsGrant();

        spotifyApi.setAccessToken(
            spotifyApi.getClientCredentialsGrant().access_token
        );

        // Extract track ID from URL
        const match = url.match(/track\/([a-zA-Z0-9]+)/);

        if (!match) {
            return res.status(400).json({
                success: false,
                error: "Only Spotify track links are supported right now"
            });
        }

        const trackId = match[1];

        const result = await spotifyApi.getTrack(trackId);

        const track = result.body;

        res.json({
            success: true,
            id: track.id,
            title: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            album: track.album.name,
            artwork: track.album.images[0]?.url || "",
            duration: track.duration_ms
        });

    } catch (error) {
        console.error("Spotify error:", error.message);

        res.status(500).json({
            success: false,
            error: "Failed to get Spotify metadata"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("SideCut backend running on port " + PORT);
});
