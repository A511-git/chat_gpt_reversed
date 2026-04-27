# SRT Processor — AI-Powered Subtitle Backend

A file-system-based backend that processes large SRT subtitle files using an AI model.
Built with **Fastify** + **chatgptreversed**, deployed via **Docker Compose**.

---

## Architecture

```
Client  →  POST /api/srt/process
              │
              ▼
        Parse SRT → Chunk (20–30 blocks)
              │
              ▼
        Write job to disk  (data/jobs/job-{uuid}/)
              │
              ▼  (worker picks it up)
        Phase 1: Full SRT → AI → Context Summary (stored in meta.json)
              │
              ▼
        Phase 2: Per-chunk → AI (with context) → results/{n}.json
              │
              ▼
        Merge → final.srt
              │
              ▼
        GET /api/srt/:jobId/download
```

---

## File System Layout

```
data/
└── jobs/
    └── job-{uuid}/
        ├── meta.json          ← job status, context summary, progress
        ├── original.srt       ← original upload (used for Phase 1)
        ├── chunks/
        │   ├── 0.json         ← subtitle blocks 1-25
        │   ├── 1.json         ← subtitle blocks 26-50
        │   └── ...
        ├── results/
        │   ├── 0.json         ← processed blocks from chunk 0
        │   └── ...
        └── final.srt          ← merged output
```

---

## Quick Start

### 1. Clone & install

```bash
npm install
```

### 2. Run locally (two terminals)

```bash
# Terminal 1 – API
npm run api

# Terminal 2 – Worker
npm run worker
```

### 3. Run with Docker

```bash
docker compose up --build
```

---

## API Reference

### `POST /api/srt/process`

Submit an SRT file for processing.

**Request body:**
```json
{
  "srtText": "1\n00:00:01,000 --> 00:00:03,000\nHello world\n\n...",
  "instruction": "Translate to Spanish",   // optional
  "chunkSize": 25                          // optional, 20–30
}
```

**Response `201`:**
```json
{
  "jobId": "job-3f4a…",
  "totalChunks": 8,
  "totalBlocks": 197
}
```

---

### `GET /api/srt/:jobId`

Poll job progress.

**Response:**
```json
{
  "jobId": "job-3f4a…",
  "status": "processing",
  "progress": "3/8",
  "contextReady": true,
  "chunks": {
    "0": { "status": "done", "retry": 0 },
    "1": { "status": "done", "retry": 0 },
    "2": { "status": "done", "retry": 1 },
    "3": { "status": "processing", "retry": 0 }
  }
}
```

**Status values:**

| Status         | Meaning                                      |
|----------------|----------------------------------------------|
| `pending`      | Waiting for Phase 1 context pass             |
| `context_pass` | Worker running Phase 1 (full-file AI read)   |
| `processing`   | Chunks being processed                       |
| `merging`      | All chunks done, writing final.srt           |
| `completed`    | Done — ready to download                     |
| `failed`       | A fatal error occurred                       |

---

### `GET /api/srt/:jobId/download`

Download the final processed `.srt` file.

Returns `Content-Type: text/plain` with `Content-Disposition: attachment`.

Returns `409` if the job is not yet completed.

---

## Two-Phase AI Strategy

### Phase 1 — Context Pass (once per job)

The full SRT is sent to the model with the prompt:

> *"Read this complete subtitle file and return a concise context summary covering topic, speakers, vocabulary, and tone."*

The summary is stored in `meta.json` as `context`.

### Phase 2 — Chunk Processing (once per chunk)

Each chunk is sent as a **structured JSON array**:

```json
[
  { "index": 1, "timestamp": "00:00:01,000 --> 00:00:03,000", "text": "Hello" }
]
```

The model is instructed to:
- Modify **only** the `text` field
- **Never** touch `index` or `timestamp`
- Return the **same JSON structure**

Output is validated; if malformed, the chunk is retried up to **3 times**.

---

## Configuration

| Env var        | Default       | Description                  |
|----------------|---------------|------------------------------|
| `PORT`         | `3000`        | API listen port              |
| `HOST`         | `0.0.0.0`     | API bind address             |
| `LOG_LEVEL`    | `info`        | Pino log level               |
| `CORS_ORIGIN`  | `*`           | CORS allowed origins         |

---

## Retry & Fault Tolerance

- Each chunk tracks `retry` count (max **3**)
- Chunks stuck in `processing` for >5 minutes are automatically reset to `pending`
- Worker loop is crash-safe — on restart it picks up from where it left off
- Duplicate processing risk is mitigated by the status-file flip pattern

---

## Scaling

To run multiple workers (higher throughput):

```bash
docker compose up --scale worker=3
```

> ⚠️ The file-system lock is optimistic (status flip), so a small chance of
> duplicate processing exists at scale. For production, replace the chunk
> store with Redis or a proper queue.
