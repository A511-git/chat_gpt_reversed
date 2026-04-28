/**
 * server.js
 * Fastify API server entry point.
 * Mounts all routes and starts listening.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import srtRoutes from "./routes/srt.js";
import { startWorker } from "../worker/worker.js";
import multipart from '@fastify/multipart';

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "3000", 10);

const fastify = Fastify({
    logger: {
        level: process.env.LOG_LEVEL || "info",
        transport:
            process.env.NODE_ENV !== "production"
                ? { target: "pino-pretty" }
                : undefined,
    },
});

// ── Plugins ──────────────────────────────────────────────────────────────────
await fastify.register(multipart);
await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN || "*",
});

// ── Routes ───────────────────────────────────────────────────────────────────

await fastify.register(srtRoutes, { prefix: "/api/srt" });

// Health check
fastify.get("/health", async () => ({ status: "ok", ts: Date.now() }));

// ── Start ─────────────────────────────────────────────────────────────────────

try {
    await fastify.listen({ host: HOST, port: PORT });
    console.log(`[api] Server listening on http://${HOST}:${PORT}`);
    startWorker();
} catch (err) {
    fastify.log.error(err);
    process.exit(1);
}