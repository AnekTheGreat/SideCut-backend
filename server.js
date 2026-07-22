const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("SideCut backend is online!");
});

app.post("/download", async (req, res) => {
    const { url } = req.body;

    console.log(url);

    res.json({
        success: true,
        message: "Received!",
        url
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Running on " + PORT);
});
