import express from "express";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {ChatGPTReversed} from "./chatgpt/index.js"; // Assumes default export
import multer from "multer";


// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const upload = multer(); // parses multipart/form-data

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DATA_DIR = path.join(__dirname, "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const LOG_FILE = path.join(DATA_DIR, "logs", "server.log");

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Initialize ChatGPT reversed instance (reuses session)
const chatGPT = new ChatGPTReversed({ maintainSession: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(level, message, extra) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}${extra !== undefined ? " | " + JSON.stringify(extra) : ""}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------
function jobDir(jobId) {
  return path.join(JOBS_DIR, jobId);
}

function saveJob(jobId, data) {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(data, null, 2), "utf-8");
  fs.writeFileSync(path.join(dir, "input.txt"), data.srtText, "utf-8");
  if (data.output !== undefined) {
    fs.writeFileSync(path.join(dir, "output.txt"), data.output, "utf-8");
  }
}

function loadJob(jobId) {
  const file = path.join(jobDir(jobId), "job.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// ---------------------------------------------------------------------------
// SRT parsing & rebuilding
// ---------------------------------------------------------------------------
function parseSrt(text) {
  const blocks = [];
  const rawBlocks = text.trim().split(/\n\s*\n/);
  for (const raw of rawBlocks) {
    const lines = raw.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const idx = parseInt(lines[0], 10);
    if (isNaN(idx)) continue;
    const timecode = lines[1];
    const textLines = lines.slice(2);
    blocks.push({ index: idx, timecode, lines: textLines });
  }
  return blocks;
}

function buildSrt(blocks) {
  return blocks
    .map((b, i) => `${i + 1}\n${b.timecode}\n${b.text}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// AI processing using ChatGPTReversed
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 40; // lines per chunk

async function processSrt(srtText, instruction, jobId) {
  const blocks = parseSrt(srtText);
  log("INFO", `[${jobId}] Parsed ${blocks.length} SRT blocks`);

  const results = [];

  for (let i = 0; i < blocks.length; i += CHUNK_SIZE) {
    const chunk = blocks.slice(i, i + CHUNK_SIZE);
    const sourceLines = chunk.map(b => b.lines.join(" ")).join("\n");

    const prompt = `You are an SRT subtitle processor. Follow the user instruction exactly.

USER INSTRUCTION:
${instruction}

For each input line below, output the processed/translated result on its own line.
If a line is noise, corrupt, or untranslatable, output exactly: SKIPPED
Output ONLY the processed lines — one per input line, nothing else.

INPUT LINES (${chunk.length} lines):
${sourceLines}`;

    log("INFO", `[${jobId}] Sending chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} lines) to ChatGPT`);

    let rawOutput = "";
    try {
      rawOutput = await chatGPT.complete(prompt);
    } catch (err) {
      log("ERROR", `[${jobId}] ChatGPT request failed`, err.message);
      // Mark all lines in this chunk as SKIPPED
      for (const block of chunk) {
        results.push({
          index: block.index,
          timecode: block.timecode,
          text: "SKIPPED",
        });
      }
      continue;
    }

    const outputLines = rawOutput.trim().split("\n").map(l => l.trim());
    log("INFO", `[${jobId}] ChatGPT returned ${outputLines.length} lines for chunk`);

    for (let j = 0; j < chunk.length; j++) {
      const translated = outputLines[j] ?? "SKIPPED";
      if (translated.toUpperCase() === "SKIPPED") {
        log("INFO", `[${jobId}] Block ${chunk[j].index} skipped`);
        continue;
      }
      results.push({
        index: chunk[j].index,
        timecode: chunk[j].timecode,
        text: translated,
      });
    }
  }

  const finalSrt = buildSrt(results);
  log("INFO", `[${jobId}] Built final SRT with ${results.length} blocks`);
  return finalSrt;
}

// ---------------------------------------------------------------------------
// Routes (identical to original)
// ---------------------------------------------------------------------------

// POST /process/srt
app.get("/process/srt", upload.none(), async (req, res) => {
  const { instruction, srtText } = req.body;
  log("INFO", "POST /process/srt", { instruction, srtText })
  if (!instruction || !srtText) {
    log("WARN", "Missing instruction or srtText in request");
    return res.status(400).json({ error: "Both 'instruction' and 'srtText' are required." });
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const jobData = { status: "queued", instruction, srtText, createdAt: now, updatedAt: now };

  saveJob(jobId, jobData);
  log("INFO", `[${jobId}] Job created`);

  // Fire and forget
  (async () => {
    try {
      saveJob(jobId, { ...jobData, status: "processing", updatedAt: new Date().toISOString() });
      log("INFO", `[${jobId}] Processing started`);

      const output = await processSrt(srtText, instruction, jobId);

      saveJob(jobId, { ...jobData, status: "done", output, updatedAt: new Date().toISOString() });
      log("INFO", `[${jobId}] Processing complete`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      saveJob(jobId, { ...jobData, status: "error", error: msg, updatedAt: new Date().toISOString() });
      log("ERROR", `[${jobId}] Processing failed`, msg);
    }
  })();

  return res.json({ jobId, status: "queued" });
});

// GET /output/srt/:jobId
app.get("/output/srt/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = loadJob(jobId);

  if (!job) {
    log("WARN", `[${jobId}] Job not found`);
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status === "queued" || job.status === "processing") {
    return res.status(202).json({ status: job.status, message: "Job is still processing." });
  }
  if (job.status === "error") {
    return res.status(500).json({ status: "error", error: job.error });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(job.output ?? "");
});

// GET /output/srt/:jobId/download
app.get("/output/srt/:jobId/download", (req, res) => {
  const { jobId } = req.params;
  const job = loadJob(jobId);

  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "done") {
    return res.status(202).json({ status: job.status, message: "Job is not done yet." });
  }

  const outputPath = path.join(jobDir(jobId), "output.txt");
  if (!fs.existsSync(outputPath)) {
    return res.status(500).json({ error: "Output file missing." });
  }

  res.setHeader("Content-Type", "application/x-subrip");
  res.setHeader("Content-Disposition", `attachment; filename="${jobId}.srt"`);
  log("INFO", `[${jobId}] SRT file downloaded`);
  return res.sendFile(outputPath);
});

// GET /logs
app.get("/logs", (_req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.status(200).send("No logs yet.");
  const logs = fs.readFileSync(LOG_FILE, "utf-8");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(logs);
});

// GET /data/input/:jobId
app.get("/data/input/:jobId", (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(jobDir(jobId), "input.txt");
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Input not found." });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.sendFile(filePath);
});

// GET /data/output/:jobId
app.get("/data/output/:jobId", (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(jobDir(jobId), "output.txt");
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Output not found." });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  log("INFO", `SRT backend (ChatGPT) listening on port ${PORT}`);
});