/**
 * worker.js
 *
 * - Persistent conversation per job (completeInConversation)
 * - No separate instruction message – the first chunk includes instruction
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
    chunkPath,
} from "../lib/jobManager.js";
import { generateContextSummary, processChunkWithConversation } from "../lib/aiProcessor.js";
import { mergeJob } from "../lib/merger.js";
import { dynamicChunkBlocks } from "../lib/chunker.js";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";   // add this line


const POLL_INTERVAL_MS = 3_000;
const MAX_CHUNK_RETRIES = 3;
const RATE_LIMIT_PAUSE = 15_000;

// ─── Self-ping ────────────────────────────────────────────────────────────────
const SELF_PING_URL = process.env.SELF_PING_URL || null;
const SELF_PING_INTERVAL = 5 * 60 * 1000;

async function hasActiveJobs() {
    const jobIds = await listAllJobIds();
    for (const jobId of jobIds) {
        const meta = await readMeta(jobId).catch(() => null);
        if (meta && meta.status !== "completed" && meta.status !== "failed") return true;
    }
    return false;
}

async function startSelfPingLoop() {
    if (!SELF_PING_URL) return;
    console.log("[worker] Self-ping enabled:", SELF_PING_URL);
    while (true) {
        try {
            if (await hasActiveJobs()) {
                console.log("[worker] Active jobs → ping");
                await fetch(SELF_PING_URL);
            }
        } catch (err) {
            console.error("[worker] Ping error:", err.message);
        }
        await sleep(SELF_PING_INTERVAL);
    }
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function runWorker() {
    console.log("[worker] Started. Polling every", POLL_INTERVAL_MS, "ms…");
    while (true) {
        try {
            await tick();
        } catch (err) {
            console.error("[worker] Tick error:", err.message);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

async function tick() {
    const jobIds = await listAllJobIds();
    for (const jobId of jobIds) {
        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) continue;
        if (meta.status === "pending") await handleContextPass(jobId, meta);
        if (meta.status === "processing") await handleChunkProcessing(jobId, meta);
    }
}

// ─── Phase 1 ─────────────────────────────────────────────────────────────────
async function handleContextPass(jobId, meta) {
    const conversationId = uuidv4();
    console.log(`[worker] [${jobId}] Context pass…`);

    await updateMeta(jobId, {
        status: "context_pass",
        conversationId,
        parentMessageId: "client-created-root",  // initial state
    });

    try {
        const fullSRT = await readOriginalSRT(jobId);
        const contextSummary = await generateContextSummary(fullSRT);
        const chunks = dynamicChunkBlocks(meta.originalBlocks, contextSummary);

        for (let i = 0; i < chunks.length; i++) {
            await writeChunk(jobId, i, { index: i, status: "pending", retry: 0, content: chunks[i] });
        }

        await updateMeta(jobId, {
            status: "processing",
            contextReady: true,
            context: contextSummary,
            totalChunks: chunks.length,
            completedChunks: 0,
        });

        console.log(`[worker] [${jobId}] Context ready. Chunks: ${chunks.length}`);
    } catch (err) {
        console.error(`[worker] [${jobId}] Context pass failed:`, err.message);
        await updateMeta(jobId, { status: "pending" });
    }
}

// ─── Phase 2 ─────────────────────────────────────────────────────────────────
async function handleChunkProcessing(jobId, meta) {
    if (await allResultsReady(jobId)) {
        await mergeJob(jobId);
        return;
    }

    await recoverStalledChunks(jobId);

    const chunk = await claimNextPendingChunk(jobId);
    if (!chunk) return;

    const instruction = meta.instruction ||
        "Fix grammar, punctuation and naturalness. Keep the meaning intact.";

    console.log(`[worker] [${jobId}] Chunk ${chunk.index}/${meta.totalChunks - 1}…`);

    try {
        const { processedBlocks, newParentMessageId } = await processChunkWithConversation(
            chunk.content,
            meta.conversationId,
            meta.parentMessageId,
            instruction
        );
        await writeResult(jobId, chunk.index, processedBlocks);

        chunk.status = "done";
        await writeChunk(jobId, chunk.index, chunk);

        // Update parent message ID for the next chunk
        await updateMeta(jobId, {
            parentMessageId: newParentMessageId,
            completedChunks: (meta.completedChunks || 0) + 1
        });
        console.log(`[worker] [${jobId}] Chunk ${chunk.index} done.`);

    } catch (err) {
        console.error(`[worker] [${jobId}] Chunk ${chunk.index} error:`, err.message);

        const is429 = err?.message?.includes("429");

        chunk.retry = (chunk.retry || 0) + 1;

        if (chunk.retry >= MAX_CHUNK_RETRIES) {
            console.warn(`[worker] [${jobId}] Chunk ${chunk.index} max retries — using original.`);
            await writeResult(jobId, chunk.index, chunk.content);
            chunk.status = "done";
            await writeChunk(jobId, chunk.index, chunk);
            await updateMeta(jobId, { completedChunks: (meta.completedChunks || 0) + 1 });
        } else {
            chunk.status = "pending";
            await writeChunk(jobId, chunk.index, chunk);
            if (is429) {
                console.warn(`[worker] 429 detected — pausing ${RATE_LIMIT_PAUSE}ms`);
                await sleep(RATE_LIMIT_PAUSE);
            }
        }
    }
}

// ─── Stall recovery ───────────────────────────────────────────────────────────
async function recoverStalledChunks(jobId) {
    const STALE = 5 * 60 * 1000;
    for (const idx of await listChunkIndices(jobId)) {
        const chunk = await readChunk(jobId, idx).catch(() => null);
        if (!chunk || chunk.status !== "processing") continue;
        const mtime = await fs.stat(chunkPath(jobId, idx)).then(s => s.mtimeMs).catch(() => 0);
        if (Date.now() - mtime > STALE) {
            console.warn(`[worker] [${jobId}] Recovering stalled chunk ${idx}`);
            chunk.status = "pending";
            await writeChunk(jobId, idx, chunk);
        }
    }
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Boot ─────────────────────────────────────────────────────────────────────
export function startWorker() {
    runWorker().catch(err => { console.error("[worker] Fatal:", err); process.exit(1); });
    startSelfPingLoop();
}