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

const app = express();
const PORT = process.env.PORT || 4000;

// ---------- BASIC MIDDLEWARE ----------
app.use(cors());
app.use(express.json());

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

const upload = multer({ dest: TMP_DIR });

const QUALITY_MAP = ["144p", "240p", "360p", "480p", "720p", "1080p"];

// small helper
const safeUnlink = (p) => {
  fs.unlink(p, (err) => {
    if (err) console.error("Failed to delete", p, err.message);
  });
};

// ---------- YOUTUBE INFO ENDPOINT ----------
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
    const { url } = req.body || {};

    if (!url || !ytdl.validateURL(url)) {
      return res.json({ error: "Invalid YouTube URL" });
    }

    const info = await ytdl.getInfo(url);

    res.json({
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails.slice(-1)[0]?.url || "",
      links: extractLinks(info),
    });
  } catch (err) {
    console.error("YOUTUBE ERROR:", err);
    res.json({ error: "Failed to fetch video info" });
  }
});

// ---------- IMAGE COMPRESSOR ----------
app.post(
  "/api/image-compress",
  upload.array("images"),
  async (req, res) => {
    try {
      const quality = Math.max(
        10,
        Math.min(100, parseInt(req.body.quality || "80", 10))
      );

      if (!req.files || req.files.length === 0) {
        return res.status(400).send("No images uploaded");
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="compressed-images.zip"'
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        console.error("ARCHIVER ERROR:", err);
        res.status(500).end();
      });
      archive.pipe(res);

      for (const file of req.files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext);

        try {
          if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
            const targetFormat =
              ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext.slice(1);

            const buf = await sharp(file.path)
              .toFormat(targetFormat, { quality })
              .toBuffer();

            archive.append(buf, {
              name: `${base}-compressed.${targetFormat === "jpeg" ? "jpg" : targetFormat}`,
            });
          } else {
            // unsupported, just add original
            archive.file(file.path, { name: file.originalname });
          }
        } catch (e) {
          console.error("IMAGE COMPRESS ERR:", e);
          archive.file(file.path, { name: file.originalname });
        } finally {
          safeUnlink(file.path);
        }
      }

      archive.finalize();
    } catch (err) {
      console.error("IMAGE COMPRESS MAIN ERR:", err);
      res.status(500).send("Image compression failed");
    }
  }
);

// ---------- GENERIC FILE COMPRESSOR (ZIP) ----------
app.post(
  "/api/file-compress",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const inputPath = req.file.path;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.file.originalname}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("FILE COMPRESS ARCHIVE ERR:", err);
      res.status(500).end();
    });

    archive.pipe(res);
    archive.file(inputPath, { name: req.file.originalname });

    archive.finalize().then(() => {
      safeUnlink(inputPath);
    });
  }
);

// ---------- PDF COMPRESSOR (Ghostscript) ----------
function compressPdfWithGhostscript(inputPath, outputPath, level = "medium") {
  const settingMap = {
    low: "/screen",
    medium: "/ebook",
    high: "/printer",
  };
  const pdfSetting = settingMap[level] || "/ebook";

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
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });
}

app.post(
  "/api/pdf-compress",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).send("No PDF uploaded");
    }

    const level = req.body.level || "medium";
    const inputPath = req.file.path;
    const outputPath = path.join(TMP_DIR, `compressed-${Date.now()}.pdf`);

    try {
      await compressPdfWithGhostscript(inputPath, outputPath);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="compressed.pdf"'
      );

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      stream.on("close", () => {
        safeUnlink(inputPath);
        safeUnlink(outputPath);
      });
    } catch (err) {
      console.error("PDF COMPRESS ERR:", err);
      safeUnlink(inputPath);
      safeUnlink(outputPath);
      res.status(500).send("PDF compression failed");
    }
  }
);

// ---------- FILE CONVERTER (images + audio/video + docs→pdf) ----------
function convertWithFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-i", inputPath, outputPath], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function convertWithLibreOffice(inputPath, targetExt, outDir) {
  return new Promise((resolve, reject) => {
    // soffice is the CLI for LibreOffice
    execFile(
      "soffice",
      [
        "--headless",
        "--convert-to",
        targetExt,
        "--outdir",
        outDir,
        inputPath,
      ],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

app.post(
  "/api/file-convert",
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const target = (req.body.target || "").toLowerCase();
    const inputPath = req.file.path;
    const origName = req.file.originalname;
    const ext = path.extname(origName).toLowerCase().replace(".", "");
    const baseName = path.basename(origName, path.extname(origName));

    try {
      let outputPath = path.join(TMP_DIR, `${baseName}-${Date.now()}.${target}`);

      const imageTypes = ["jpg", "jpeg", "png", "webp"];
      const avTypes = ["mp4", "mp3", "wav"];
      const docTypes = ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "txt"];

      if (imageTypes.includes(ext) && imageTypes.includes(target)) {
        // image -> image
        const targetFormat = target === "jpg" ? "jpeg" : target;
        const buf = await sharp(inputPath)
          .toFormat(targetFormat, { quality: 80 })
          .toBuffer();

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${baseName}.${target}"`
        );
        res.end(buf);
        safeUnlink(inputPath);
        return;
      }

      if (avTypes.includes(ext) && avTypes.includes(target)) {
        // audio/video conversion
        await convertWithFfmpeg(inputPath, outputPath);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${baseName}.${target}"`
        );

        const stream = fs.createReadStream(outputPath);
        stream.pipe(res);
        stream.on("close", () => {
          safeUnlink(inputPath);
          safeUnlink(outputPath);
        });
        return;
      }

      if (target === "pdf" && docTypes.includes(ext)) {
        // docs -> pdf using LibreOffice
        const outDir = TMP_DIR;
        await convertWithLibreOffice(inputPath, "pdf", outDir);
        outputPath = path.join(outDir, `${baseName}.pdf`);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${baseName}.pdf"`
        );

        const stream = fs.createReadStream(outputPath);
        stream.pipe(res);
        stream.on("close", () => {
          safeUnlink(inputPath);
          safeUnlink(outputPath);
        });
        return;
      }

      // unsupported combo
      safeUnlink(inputPath);
      return res
        .status(400)
        .json({ error: `Conversion from .${ext} to .${target} is not supported yet.` });
    } catch (err) {
      console.error("FILE CONVERT ERR:", err);
      safeUnlink(inputPath);
      res.status(500).send("File conversion failed");
    }
  }
);

// ---------- RAZORPAY: CREATE ORDER ----------
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

app.post("/api/create-order", async (req, res) => {
  try {
    if (!razorpay) {
      return res.json({ success: false, error: "Razorpay not configured" });
    }

    const amount = Number(req.body.amount || 0);
    if (!amount || amount <= 0) {
      return res.json({ success: false, error: "Invalid amount" });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      payment_capture: 1,
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error("RAZORPAY ORDER ERR:", err);
    res.json({ success: false, error: "Order creation failed" });
  }
});

// ---------- RAZORPAY: VERIFY PAYMENT ----------
app.post("/api/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res.json({ verified: false });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      return res.json({ verified: true });
    }

    res.json({ verified: false });
  } catch (err) {
    console.error("VERIFY PAYMENT ERR:", err);
    res.json({ verified: false });
  }
});

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.send("MicroTools backend OK");
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`🚀 MicroTools backend running on port ${PORT}`);
});
