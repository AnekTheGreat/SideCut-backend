const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("SideCut backend is online!");
});


// Spotify metadata endpoint
app.post("/metadata", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "No URL provided"
        });
    }

    try {
        const match = url.match(
            /spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/
        );

        if (!match) {
            return res.status(400).json({
                success: false,
                error: "Invalid Spotify link"
            });
        }

        const type = match[1];
        const id = match[2];

        res.json({
            success: true,
            type: type,
            id: id,

            // Metadata placeholders
            // These will be filled when a real metadata provider is connected
            title: "Spotify Track",
            artist: "Unknown Artist",
            album: "Spotify",
            artwork: "",

            url: url
        });

    } catch (error) {
        console.error("Metadata error:", error);

        res.status(500).json({
            success: false,
            error: "Server error"
        });
    }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("SideCut backend running on port " + PORT);
});
