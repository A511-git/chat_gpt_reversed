/**
 * worker.js
 * Standalone worker process that continuously scans jobs and processes chunks.
 *
 * Processing pipeline per job:
 *   1. If status === "pending"     → run Phase 1 (context pass)
 *   2. If status === "processing"  → claim a pending chunk and run Phase 2
 *   3. If all chunks done          → run merger
 *   4. Sleep and repeat
 */

import {
    listAllJobIds,
    readMeta,
    updateMeta,
    readOriginalSRT,
    claimNextPendingChunk,
    readChunk,
    writeChunk,
    writeResult,
    allResultsReady,
    listChunkIndices,
} from "../lib/jobManager.js";
import { generateContextSummary, processChunk } from "../lib/aiProcessor.js";
import { mergeJob } from "../lib/merger.js";

const POLL_INTERVAL_MS = 3_000;   // How often to scan for work
const MAX_CHUNK_RETRIES = 3;

// ─── Self Pinging ───────────────────────────────────────────────────────────────

const SELF_PING_URL = process.env.SELF_PING_URL || null;
const SELF_PING_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function hasActiveJobs() {
    const jobIds = await listAllJobIds();

    for (const jobId of jobIds) {
        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) continue;

        if (meta.status !== "completed" && meta.status !== "failed") {
            return true;
        }
    }

    return false;
}

async function startSelfPingLoop() {
    if (!SELF_PING_URL) return;

    console.log("[worker] Self-ping enabled:", SELF_PING_URL);

    while (true) {
        try {
            const active = await hasActiveJobs();

            if (active) {
                console.log("[worker] Active jobs found → sending self-ping");

                await fetch(SELF_PING_URL, {
                    method: "GET",
                });
            } else {
                console.log("[worker] No active jobs → skipping self-ping");
            }
        } catch (err) {
            console.error("[worker] Self-ping failed:", err.message);
        }

        await sleep(SELF_PING_INTERVAL);
    }
}



// ─── Main loop ───────────────────────────────────────────────────────────────

async function runWorker() {
    console.log("[worker] Started. Polling every", POLL_INTERVAL_MS, "ms…");

    while (true) {
        try {
            await tick();
        } catch (err) {
            console.error("[worker] Unexpected tick error:", err.message);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

async function tick() {
    const jobIds = await listAllJobIds();

    for (const jobId of jobIds) {
        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) continue;

        switch (meta.status) {
            case "pending":
                await handleContextPass(jobId, meta);
                break;

            case "processing":
                await handleChunkProcessing(jobId, meta);
                break;

            // context_pass / merging → being handled, skip
            // completed / failed     → nothing to do
            default:
                break;
        }
    }
}

// ─── Phase 1: Context pass ───────────────────────────────────────────────────

async function handleContextPass(jobId, meta) {
    console.log(`[worker] [${jobId}] Starting context pass…`);
    await updateMeta(jobId, { status: "context_pass" });

    try {
        const fullSRT = await readOriginalSRT(jobId);
        const contextSummary = await generateContextSummary(fullSRT);

        await updateMeta(jobId, {
            status: "processing",
            contextReady: true,
            context: contextSummary,
        });

        console.log(`[worker] [${jobId}] Context ready. Starting chunk processing…`);
    } catch (err) {
        console.error(`[worker] [${jobId}] Context pass failed:`, err.message);
        await updateMeta(jobId, { status: "pending" }); // reset so it retries
    }
}

// ─── Phase 2: Chunk processing ───────────────────────────────────────────────

async function handleChunkProcessing(jobId, meta) {
    // Check if all chunks are done → merge
    if (await allResultsReady(jobId)) {
        await mergeJob(jobId);
        return;
    }

    // Also check for any "processing" chunks that timed out / crashed
    await recoverStalledChunks(jobId);

    // Claim the next pending chunk (marks it "processing" atomically-ish)
    const chunk = await claimNextPendingChunk(jobId);
    if (!chunk) return; // nothing left to do right now

    console.log(`[worker] [${jobId}] Processing chunk ${chunk.index}/${meta.totalChunks - 1}…`);

    try {
        // Determine the user instruction – stored in meta at job creation
        const instruction = meta.instruction || "Fix grammar, punctuation and naturalness of the subtitles. Keep the meaning intact.";

        const processedBlocks = await processChunk(
            chunk.content,
            meta.context,
            instruction,
        );

        // Store result
        await writeResult(jobId, chunk.index, processedBlocks);

        // Mark chunk as done
        chunk.status = "done";
        await writeChunk(jobId, chunk.index, chunk);

        // Increment completedChunks counter
        const fresh = await readMeta(jobId).catch(() => meta);
        await updateMeta(jobId, {
            completedChunks: (fresh.completedChunks || 0) + 1,
        });

        console.log(`[worker] [${jobId}] Chunk ${chunk.index} done.`);
    } catch (err) {
        console.error(`[worker] [${jobId}] Chunk ${chunk.index} error:`, err.message);

        chunk.retry = (chunk.retry || 0) + 1;

        if (chunk.retry >= MAX_CHUNK_RETRIES) {
            console.error(`[worker] [${jobId}] Chunk ${chunk.index} exceeded max retries. Marking failed.`);
            chunk.status = "failed";
        } else {
            // Reset to pending so it gets retried
            chunk.status = "pending";
        }

        await writeChunk(jobId, chunk.index, chunk);
    }
}

/**
 * Reset chunks that were stuck in "processing" state for too long.
 * This handles crashed worker instances.
 * Simple heuristic: if a chunk has been "processing" for > 5 minutes, reset it.
 */
async function recoverStalledChunks(jobId) {
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const indices = await listChunkIndices(jobId);

    for (const idx of indices) {
        const chunk = await readChunk(jobId, idx).catch(() => null);
        if (!chunk || chunk.status !== "processing") continue;

        const mtime = await getFileMtime(jobId, idx);
        if (Date.now() - mtime > STALE_THRESHOLD_MS) {
            console.warn(`[worker] [${jobId}] Recovering stalled chunk ${idx}`);
            chunk.status = "pending";
            await writeChunk(jobId, idx, chunk);
        }
    }
}

import fs from "fs/promises";
import path from "path";
import { chunkPath } from "../lib/jobManager.js";

async function getFileMtime(jobId, idx) {
    try {
        const stat = await fs.stat(chunkPath(jobId, idx));
        return stat.mtimeMs;
    } catch {
        return 0;
    }
}

// ─── Util ────────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Boot ────────────────────────────────────────────────────────────────────

export function startWorker() {
    runWorker().catch((err) => {
        console.error("[worker] Fatal:", err);
        process.exit(1);
    });

    // self-ping loop
    startSelfPingLoop();
}