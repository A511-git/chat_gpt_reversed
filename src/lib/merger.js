/**
 * merger.js
 * Reads all result files for a job, sorts them by chunk index,
 * flattens the blocks, re-sequences subtitle indices, and writes final.srt
 */

import {
    listAllJobIds,
    readResult,
    readMeta,
    writeFinalSRT,
    updateMeta,
    resultsDir,
} from "./jobManager.js";
import { blocksToSRT } from "./srtParser.js";
import fs from "fs/promises";

/**
 * Merge all result chunks for a job into a final SRT file.
 * Updates job status to "completed" on success, "failed" on error.
 *
 * @param {string} jobId
 */
export async function mergeJob(jobId) {
    try {
        await updateMeta(jobId, { status: "merging" });

        const meta = await readMeta(jobId);

        // Read and sort all result files
        const allBlocks = [];
        for (let i = 0; i < meta.totalChunks; i++) {
            const resultBlocks = await readResult(jobId, i);
            allBlocks.push(...resultBlocks);
        }

        // Sort by original subtitle index (preserves full ordering)
        allBlocks.sort((a, b) => a.index - b.index);

        // Re-number sequentially starting from 1 (standard SRT requirement)
        const reindexed = allBlocks.map((b, pos) => ({
            ...b,
            index: pos + 1,
        }));

        const srtText = blocksToSRT(reindexed);
        await writeFinalSRT(jobId, srtText);
        await updateMeta(jobId, { status: "completed" });

        console.log(`[merger] Job ${jobId} merged successfully (${reindexed.length} blocks)`);
    } catch (err) {
        console.error(`[merger] Failed to merge job ${jobId}:`, err.message);
        await updateMeta(jobId, { status: "failed", mergeError: err.message });
    }
}