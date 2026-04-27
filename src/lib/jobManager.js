/**
 * jobManager.js
 * All file-system operations for reading/writing job state.
 *
 * Directory layout:
 *   data/jobs/job-{id}/
 *     meta.json          – job metadata
 *     chunks/{n}.json    – input chunks
 *     results/{n}.json   – processed results
 *     final.srt          – merged output
 */

import fs from "fs/promises";
import path from "path";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DATA_ROOT = path.resolve("data/jobs");

export const jobDir = (jobId) => path.join(DATA_ROOT, jobId);
export const metaPath = (jobId) => path.join(jobDir(jobId), "meta.json");
export const chunksDir = (jobId) => path.join(jobDir(jobId), "chunks");
export const resultsDir = (jobId) => path.join(jobDir(jobId), "results");
export const finalPath = (jobId) => path.join(jobDir(jobId), "final.srt");
export const chunkPath = (jobId, idx) => path.join(chunksDir(jobId), `${idx}.json`);
export const resultPath = (jobId, idx) => path.join(resultsDir(jobId), `${idx}.json`);

// ─── Job creation ────────────────────────────────────────────────────────────

/**
 * Bootstrap all directories and write initial meta + chunk files.
 * @param {string} jobId
 * @param {object[]} chunks  - from chunker.chunkBlocks()
 * @param {string} fullSrtContext - raw full SRT stored for context pass
 */
export async function createJob(jobId, chunks, fullSrtContext) {
    await fs.mkdir(chunksDir(jobId), { recursive: true });
    await fs.mkdir(resultsDir(jobId), { recursive: true });

    const meta = {
        jobId,
        status: "pending",          // pending | context_pass | processing | merging | completed | failed
        totalChunks: chunks.length,
        completedChunks: 0,
        contextReady: false,        // set to true after first-pass AI context is generated
        context: null,              // summary returned by first-pass call
        createdAt: Date.now(),
    };

    await fs.writeFile(metaPath(jobId), JSON.stringify(meta, null, 2));
    await fs.writeFile(
        path.join(jobDir(jobId), "original.srt"),
        fullSrtContext,
    );

    // Write each chunk file
    for (const chunk of chunks) {
        await fs.writeFile(chunkPath(jobId, chunk.index), JSON.stringify(chunk, null, 2));
    }
}

// ─── Meta helpers ────────────────────────────────────────────────────────────

export async function readMeta(jobId) {
    const raw = await fs.readFile(metaPath(jobId), "utf8");
    return JSON.parse(raw);
}

export async function writeMeta(jobId, meta) {
    await fs.writeFile(metaPath(jobId), JSON.stringify(meta, null, 2));
}

export async function updateMeta(jobId, patch) {
    const meta = await readMeta(jobId);
    await writeMeta(jobId, { ...meta, ...patch });
}

// ─── Chunk helpers ───────────────────────────────────────────────────────────

export async function readChunk(jobId, idx) {
    const raw = await fs.readFile(chunkPath(jobId, idx), "utf8");
    return JSON.parse(raw);
}

export async function writeChunk(jobId, idx, chunk) {
    await fs.writeFile(chunkPath(jobId, idx), JSON.stringify(chunk, null, 2));
}

/**
 * List all chunk indices for a job.
 */
export async function listChunkIndices(jobId) {
    const files = await fs.readdir(chunksDir(jobId));
    return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => parseInt(f, 10))
        .sort((a, b) => a - b);
}

/**
 * Find the first chunk with status "pending".
 * Returns null if none found.
 */
export async function claimNextPendingChunk(jobId) {
    const indices = await listChunkIndices(jobId);
    for (const idx of indices) {
        const chunk = await readChunk(jobId, idx);
        if (chunk.status === "pending") {
            // Mark as processing before returning to reduce (not eliminate) races
            chunk.status = "processing";
            await writeChunk(jobId, idx, chunk);
            return chunk;
        }
    }
    return null;
}

// ─── Result helpers ──────────────────────────────────────────────────────────

export async function writeResult(jobId, idx, resultBlocks) {
    await fs.writeFile(resultPath(jobId, idx), JSON.stringify(resultBlocks, null, 2));
}

export async function readResult(jobId, idx) {
    const raw = await fs.readFile(resultPath(jobId, idx), "utf8");
    return JSON.parse(raw);
}

export async function allResultsReady(jobId) {
    const meta = await readMeta(jobId);
    const files = await fs.readdir(resultsDir(jobId)).catch(() => []);
    return files.filter((f) => f.endsWith(".json")).length === meta.totalChunks;
}

// ─── Final SRT ───────────────────────────────────────────────────────────────

export async function writeFinalSRT(jobId, srtText) {
    await fs.writeFile(finalPath(jobId), srtText, "utf8");
}

export async function readFinalSRT(jobId) {
    return fs.readFile(finalPath(jobId), "utf8");
}

// ─── Job scanning ────────────────────────────────────────────────────────────

/**
 * List all jobIds present on disk.
 */
export async function listAllJobIds() {
    await fs.mkdir(DATA_ROOT, { recursive: true });
    const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
    return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
}

/**
 * Read original SRT stored for context pass.
 */
export async function readOriginalSRT(jobId) {
    return fs.readFile(path.join(jobDir(jobId), "original.srt"), "utf8");
}