/**
 * routes/srt.js
 * All SRT-related API routes:
 *
 *   POST /api/srt/process           - upload SRT, create job
 *   GET  /api/srt/:jobId            - poll job status
 *   GET  /api/srt/:jobId/download   - download final.srt
 */

import { v4 as uuidv4 } from "uuid";
import { parseSRT } from "../../lib/srtParser.js";
import { chunkBlocks } from "../../lib/chunker.js";
import {
    createJob,
    readMeta,
    listChunkIndices,
    readChunk,
    readFinalSRT,
    finalPath,
} from "../../lib/jobManager.js";
import fs from "fs/promises";

export default async function srtRoutes(fastify) {
    // ── POST /api/srt/process ──────────────────────────────────────────────────
    fastify.post("/process", {
        schema: {
            body: {
                type: "object",
                required: ["srtText"],
                properties: {
                    srtText: { type: "string", minLength: 1 },
                    instruction: { type: "string" },    // optional custom AI instruction
                    chunkSize: { type: "integer", minimum: 20, maximum: 30 },
                },
            },
        },
    }, async (request, reply) => {
        const {
            srtText,
            instruction = "Fix grammar, punctuation and naturalness of the subtitles. Keep the meaning intact.",
            chunkSize = 25,
        } = request.body;

        // 1. Parse SRT → blocks
        const blocks = parseSRT(srtText);
        if (blocks.length === 0) {
            return reply.code(400).send({ error: "No valid subtitle blocks found in srtText" });
        }

        // 2. Chunk blocks
        const chunks = chunkBlocks(blocks, chunkSize);

        // 3. Create job on disk
        const jobId = `job-${uuidv4()}`;
        await createJob(jobId, chunks, srtText);

        // 4. Persist instruction in meta so the worker can read it
        // (createJob sets status: "pending" – worker picks it up automatically)
        const metaPath = (await import("../../lib/jobManager.js")).metaPath(jobId);
        const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
        meta.instruction = instruction;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

        fastify.log.info(`[api] Created job ${jobId} with ${chunks.length} chunks`);

        return reply.code(201).send({
            jobId,
            totalChunks: chunks.length,
            totalBlocks: blocks.length,
        });
    });

    // ── GET /api/srt/:jobId ────────────────────────────────────────────────────
    fastify.get("/:jobId", async (request, reply) => {
        const { jobId } = request.params;

        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) {
            return reply.code(404).send({ error: "Job not found" });
        }

        // Build a chunk-level breakdown for visibility
        const chunkIndices = await listChunkIndices(jobId).catch(() => []);
        const chunkStatuses = {};
        for (const idx of chunkIndices) {
            const chunk = await readChunk(jobId, idx).catch(() => null);
            if (chunk) chunkStatuses[idx] = { status: chunk.status, retry: chunk.retry };
        }

        return {
            jobId: meta.jobId,
            status: meta.status,
            progress: `${meta.completedChunks}/${meta.totalChunks}`,
            contextReady: meta.contextReady,
            chunks: chunkStatuses,
            createdAt: meta.createdAt,
        };
    });

    // ── GET /api/srt/:jobId/download ───────────────────────────────────────────
    fastify.get("/:jobId/download", async (request, reply) => {
        const { jobId } = request.params;

        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) {
            return reply.code(404).send({ error: "Job not found" });
        }

        if (meta.status !== "completed") {
            return reply.code(409).send({
                error: "Job not yet completed",
                status: meta.status,
                progress: `${meta.completedChunks}/${meta.totalChunks}`,
            });
        }

        const srtContent = await readFinalSRT(jobId).catch(() => null);
        if (!srtContent) {
            return reply.code(500).send({ error: "Final SRT file missing" });
        }

        return reply
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Content-Disposition", `attachment; filename="${jobId}.srt"`)
            .send(srtContent);
    });
}