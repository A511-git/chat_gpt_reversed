import { v4 as uuidv4 } from "uuid";
import { parseSRT } from "../../lib/srtParser.js";
import {
    createJob,
    readMeta,
    listChunkIndices,
    readChunk,
    readFinalSRT,
} from "../../lib/jobManager.js";
import fs from "fs/promises";

export default async function srtRoutes(fastify) {

    // ── POST /api/srt/process ─────────────────────────────
    fastify.post("/process", async (request, reply) => {

        let srtText;
        let instruction = "Fix grammar, punctuation and naturalness of the subtitles. Keep the meaning intact.";

        // ── Parse input ───────────────────────────────────
        if (request.isMultipart()) {
            const parts = request.parts();

            for await (const part of parts) {
                if (part.type === "file") {
                    const buffer = await part.toBuffer();
                    srtText = buffer.toString();
                } else {
                    if (part.fieldname === "srtText") srtText = part.value;
                    if (part.fieldname === "instruction") instruction = part.value || instruction;
                }
            }
        } else {
            ({
                srtText,
                instruction = instruction,
            } = request.body);
        }

        if (!srtText || typeof srtText !== "string") {
            return reply.code(400).send({ error: "srtText is required" });
        }

        // ── Parse SRT → blocks ────────────────────────────
        const blocks = parseSRT(srtText);

        if (blocks.length === 0) {
            return reply.code(400).send({ error: "No valid subtitle blocks found" });
        }

        // ── Create job WITHOUT chunks ─────────────────────
        const jobId = `job-${uuidv4()}`;
        await createJob(jobId, [], srtText); // no chunking here

        // ── Save metadata ─────────────────────────────────
        const { metaPath } = await import("../../lib/jobManager.js");
        const metaFile = metaPath(jobId);

        const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));

        meta.instruction = instruction;
        meta.originalBlocks = blocks; // 🔥 IMPORTANT (worker uses this)
        meta.totalChunks = 0;
        meta.completedChunks = 0;

        await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));

        fastify.log.info(`[api] Created job ${jobId} with ${blocks.length} blocks`);

        return reply.code(201).send({
            jobId,
            totalBlocks: blocks.length,
            message: "Job created. Chunking will be done by worker dynamically.",
        });
    });

    // ── GET /api/srt/:jobId ─────────────────────────────
    fastify.get("/:jobId", async (request, reply) => {
        const { jobId } = request.params;

        const meta = await readMeta(jobId).catch(() => null);
        if (!meta) {
            return reply.code(404).send({ error: "Job not found" });
        }

        const chunkIndices = await listChunkIndices(jobId).catch(() => []);
        const chunkStatuses = {};

        for (const idx of chunkIndices) {
            const chunk = await readChunk(jobId, idx).catch(() => null);
            if (chunk) {
                chunkStatuses[idx] = {
                    status: chunk.status,
                    retry: chunk.retry,
                };
            }
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

    // ── GET /api/srt/:jobId/download ─────────────────────
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
            return reply.code(500).send({ error: "Final SRT missing" });
        }

        return reply
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Content-Disposition", `attachment; filename="${jobId}.srt"`)
            .send(srtContent);
    });
}