// ------------------ CORE SETUP ------------------
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const sharp = require("sharp");
const ytdl = require("ytdl-core");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { execFile } = require("child_process");
const axios = require("axios"); // ⭐ Needed for external APIs
const QRCode = require("qrcode"); // ⭐ Local QR generator

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({ dest: TMP_DIR });

const QUALITY_MAP = ["144p", "240p", "360p", "480p", "720p", "1080p"];

const safeUnlink = (p) => fs.unlink(p, () => {});


// ------------------------------------------------------
//   EXISTING ROUTES (YouTube + Compressors + Converter)
// ------------------------------------------------------
// ⭐⭐ I am NOT modifying anything below this line.
// ONLY adding new tools after these routes.
// ------------------------------------------------------

// ---- YOUTUBE ----
function extractLinks(info) {
  const formats = info.formats;
  const links = {};

  QUALITY_MAP.forEach((q) => {
    const fmt = formats.find((f) => f.qualityLabel === q && f.hasVideo);
    links[q] = fmt ? fmt.url : null;
  });

  return links;
}

app.post("/api/youtube", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !ytdl.validateURL(url)) return res.json({ error: "Invalid URL" });

    const info = await ytdl.getInfo(url);
    res.json({
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails.slice(-1)[0]?.url,
      links: extractLinks(info),
    });
  } catch (e) {
    res.json({ error: "Failed to fetch video info" });
  }
});

// ---- IMAGE COMPRESSOR ----
app.post("/api/image-compress", upload.array("images"), async (req, res) => {
  try {
    const quality = Math.max(10, Math.min(100, parseInt(req.body.quality || "80")));
    if (!req.files?.length) return res.status(400).send("No images uploaded");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="compressed-images.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext);

      try {
        const buf = await sharp(file.path)
          .toFormat(ext === ".jpg" ? "jpeg" : ext.slice(1), { quality })
          .toBuffer();

        archive.append(buf, { name: `${base}-compressed${ext}` });
      } catch {
        archive.file(file.path, { name: file.originalname });
      } finally {
        safeUnlink(file.path);
      }
    }

    archive.finalize();
  } catch {
    res.status(500).send("Image compression failed");
  }
});

// ---- FILE COMPRESSOR ----
app.post("/api/file-compress", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${req.file.originalname}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(res);
  archive.file(req.file.path, { name: req.file.originalname });

  archive.finalize().then(() => safeUnlink(req.file.path));
});

// ---- PDF COMPRESSOR ----
function compressPdf(input, output, level = "medium") {
  const map = { low: "/screen", medium: "/ebook", high: "/printer" };
  const pdfSetting = map[level] || "/ebook";

  return new Promise((resolve, reject) => {
    execFile(
      "gs",
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        `-dPDFSETTINGS=${pdfSetting}`,
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        `-sOutputFile=${output}`,
        input,
      ],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

app.post("/api/pdf-compress", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No PDF uploaded");

  const input = req.file.path;
  const output = path.join(TMP_DIR, `compressed-${Date.now()}.pdf`);

  try {
    await compressPdf(input, output);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=compressed.pdf");

    fs.createReadStream(output).pipe(res).on("close", () => {
      safeUnlink(input);
      safeUnlink(output);
    });
  } catch {
    safeUnlink(input);
    res.status(500).send("PDF compression failed");
  }
});

// ---- FILE CONVERTER ----
function convertFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", input, output], (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function convertLibreOffice(input, target, outDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "soffice",
      ["--headless", "--convert-to", target, "--outdir", outDir, input],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

app.post("/api/file-convert", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const target = req.body.target.toLowerCase();
  const input = req.file.path;
  const ext = path.extname(req.file.originalname).replace(".", "");
  const base = path.basename(req.file.originalname, path.extname(req.file.originalname));
  let output = path.join(TMP_DIR, `${base}-${Date.now()}.${target}`);

  try {
    // Images → images
    if (["jpg", "jpeg", "png", "webp"].includes(ext) && ["jpg", "png", "webp"].includes(target)) {
      const buf = await sharp(input).toFormat(target).toBuffer();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.${target}"`);
      res.end(buf);
      safeUnlink(input);
      return;
    }

    // Audio/video → audio/video
    if (["mp4", "mp3", "wav"].includes(ext) && ["mp4", "mp3", "wav"].includes(target)) {
      await convertFfmpeg(input, output);
      res.download(output, () => {
        safeUnlink(input);
        safeUnlink(output);
      });
      return;
    }

    // Docs → PDF
    if (target === "pdf") {
      await convertLibreOffice(input, "pdf", TMP_DIR);
      output = path.join(TMP_DIR, `${base}.pdf`);
      res.download(output, () => {
        safeUnlink(input);
        safeUnlink(output);
      });
      return;
    }

    return res.json({ error: "Unsupported conversion" });
  } catch (e) {
    safeUnlink(input);
    res.status(500).send("Conversion failed");
  }
});


// ======================================================
//          ⭐⭐⭐ NEWLY ADDED DOWNLOADERS ⭐⭐⭐
// ======================================================

// ---------------- INSTAGRAM DOWNLOADER ----------------
app.post("/api/download/instagram", async (req, res) => {
  try {
    const { url } = req.body;
    const api = `https://instasaveapi.vercel.app/api/instagram?url=${url}`;
    const { data } = await axios.get(api);

    if (!data.media?.length) return res.json({ error: "Failed to fetch media" });

    res.json({
      success: true,
      url: data.media[0].url
    });
  } catch (e) {
    res.json({ error: "Instagram download failed" });
  }
});

// ---------------- TIKTOK DOWNLOADER ----------------
app.post("/api/download/tiktok", async (req, res) => {
  try {
    const { url } = req.body;
    const api = `https://www.tikwm.com/api/?url=${url}`;
    const { data } = await axios.get(api);

    res.json({
      success: true,
      url: data.data.play // no watermark
    });
  } catch {
    res.json({ error: "TikTok download failed" });
  }
});

// ---------------- FACEBOOK DOWNLOADER ----------------
app.post("/api/download/facebook", async (req, res) => {
  try {
    const { url } = req.body;
    const api = `https://api.snapsave.app/?url=${url}`;
    const { data } = await axios.get(api);

    res.json({
      success: true,
      url: data.result?.[0]?.url
    });
  } catch {
    res.json({ error: "Facebook download failed" });
  }
});

// ---------------- TWITTER DOWNLOADER ----------------
import { exec } from "child_process";
import fs from "fs";
import path from "path";

app.post("/api/download/twitter", async (req, res) => {
  try {
    const { url } = req.body;

    // ✅ Validate input
    if (!url || !url.includes("twitter.com") && !url.includes("x.com")) {
      return res.status(400).json({ error: "Invalid Twitter/X URL" });
    }

    // ✅ Temp output path
    const id = Date.now();
    const outputPath = path.join("downloads", `twitter-${id}.mp4`);

    // ✅ yt-dlp command
    const cmd = `yt-dlp -f mp4 -o "${outputPath}" "${url}"`;

    exec(cmd, (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Failed to download video" });
      }

      // ✅ Send file
      res.download(outputPath, () => {
        // cleanup after send
        fs.unlink(outputPath, () => {});
      });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Twitter download failed" });
  }
});



// ======================================================
//          ⭐⭐⭐ UTILITY TOOLS (Local Processing) ⭐⭐⭐
// ======================================================

// ---------------- BACKGROUND REMOVER ----------------
app.post("/api/remove-bg", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).send("Upload an image");

  try {
    const apiRes = await axios({
      method: "post",
      url: "https://api.remove.bg/v1.0/removebg",
      data: {
        image_file: fs.createReadStream(req.file.path)
      },
      headers: {
        "X-Api-Key": process.env.REMOVE_BG_KEY
      },
      responseType: "arraybuffer"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(apiRes.data);
  } catch {
    res.status(500).send("Background removal failed");
  } finally {
    safeUnlink(req.file.path);
  }
});

// ---------------- WATERMARK REMOVER ----------------
app.post("/api/watermark", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).send("Upload an image");

  try {
    // Simple blur-based watermark remover
    const output = path.join(TMP_DIR, `wm-${Date.now()}.png`);

    await sharp(req.file.path)
      .blur(4)
      .toFile(output);

    res.download(output, () => {
      safeUnlink(req.file.path);
      safeUnlink(output);
    });
  } catch {
    res.status(500).send("Failed to remove watermark");
  }
});

// ---------------- IMAGE RESIZER ----------------
app.post("/api/resize", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).send("Upload an image");

  const { width, height } = req.body;

  try {
    const buf = await sharp(req.file.path)
      .resize(Number(width), Number(height))
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.end(buf);
  } catch {
    res.status(500).send("Resize failed");
  } finally {
    safeUnlink(req.file.path);
  }
});

// ---------------- QR CODE GENERATOR ----------------
app.post("/api/qrcode", async (req, res) => {
  const { text } = req.body;

  try {
    const qr = await QRCode.toDataURL(text);
    res.json({ success: true, qr });
  } catch {
    res.json({ error: "QR generation failed" });
  }
});


// ------------------------------------------------------
//              HEALTH CHECK
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("MicroTools backend OK");
});

// ------------------------------------------------------
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));

