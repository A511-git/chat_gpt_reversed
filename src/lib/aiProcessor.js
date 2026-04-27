/**
 * aiProcessor.js
 *
 * Two-phase AI processing strategy:
 *
 * Phase 1 – Context Pass (once per job)
 *   Send the FULL raw SRT to the model so it understands the overall
 *   content, speakers, domain vocabulary, and tone.
 *   Store the returned context summary in meta.json.
 *
 * Phase 2 – Chunk Processing (once per chunk)
 *   Send each chunk as structured JSON together with the stored context.
 *   The model must return the SAME JSON structure, modifying ONLY `text`.
 */

import { ChatGPTReversed } from "chatgptreversed";

const chatgpt = new ChatGPTReversed();

const MAX_RETRIES = 3;

// ─── Phase 1: Context Pass ───────────────────────────────────────────────────

/**
 * Send the full SRT to the model and receive a context summary.
 * This is called once when a job is first created, before any chunks
 * are processed.
 *
 * @param {string} fullSrtText - Complete raw SRT content
 * @returns {Promise<string>} - A concise context summary from the model
 */
export async function generateContextSummary(fullSrtText) {
    const prompt = `You are an expert subtitle translator and editor.

Below is the COMPLETE subtitle file you will be working on.
Read it carefully and produce a CONCISE CONTEXT SUMMARY (max 200 words) covering:
- Topic / subject matter
- Key speakers or characters (if identifiable)
- Domain vocabulary or jargon to watch for
- Overall tone (formal, casual, technical, etc.)

This summary will be injected into every subsequent subtitle-editing request
so you can maintain perfect consistency throughout.

Do NOT edit anything yet. Only return the summary.

--- FULL SRT FILE START ---
${fullSrtText}
--- FULL SRT FILE END ---`;

    const response = await chatgpt.complete(prompt);
    return response.trim();
}

// ─── Phase 2: Chunk Processing ───────────────────────────────────────────────

/**
 * Process a single chunk of subtitle blocks using the model.
 *
 * Rules enforced via prompt:
 *   - Modify ONLY the `text` field of each block
 *   - NEVER change `index` or `timestamp`
 *   - Return valid JSON array – no markdown fences, no extra keys
 *
 * @param {{ index: number, timestamp: string, text: string }[]} blocks
 * @param {string} contextSummary - Summary from Phase 1
 * @param {string} userInstruction - What the user wants done (e.g. "translate to Spanish")
 * @returns {Promise<{ index: number, timestamp: string, text: string }[]>}
 */
export async function processChunk(blocks, contextSummary, userInstruction) {
    const inputJson = JSON.stringify(blocks, null, 2);

    const prompt = `You are an expert subtitle translator and editor working on a larger subtitle file.

## CONTEXT SUMMARY
${contextSummary}

## YOUR TASK
${userInstruction}

## SUBTITLE OPTIMIZATION RULES (VERY IMPORTANT)

You are NOT writing paragraphs. You are editing subtitles for screen readability.

Follow these strictly:

1. Fix grammar, spelling, and incorrect words.
2. If a word is clearly wrong or misheard, replace it with the most likely correct word.
3. Remove filler / noise words:
   - uh, um, you know, like, actually, basically, etc.
4. Remove repetition:
   - "I I think" → "I think"
   - "very very good" → "very good"
5. Keep subtitles SHORT and READABLE:
   - Do NOT expand into long sentences
   - Avoid adding extra explanation
6. Maintain approximately the SAME LENGTH:
   - Do NOT significantly increase word count
   - Slight shortening is preferred over expansion
7. Preserve meaning EXACTLY:
   - Do NOT change intent or tone
8. Keep natural spoken style:
   - Not too formal unless context demands it
9. If text is already good → keep it unchanged

## STRICT STRUCTURE RULES
0. Translate in ENGLISH ONLY
1. Return ONLY a valid JSON array
2. Modify ONLY the "text" field
3. NEVER change "index" or "timestamp"
4. Keep SAME number of items
5. No markdown, no backticks, no explanations

## INPUT
${inputJson}

## OUTPUT (JSON only)`;

    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const raw = await chatgpt.complete(prompt);
            const parsed = safeParseJSON(raw);
            validateChunkOutput(blocks, parsed);
            return parsed;
        } catch (err) {
            lastError = err;
            console.warn(`[aiProcessor] Attempt ${attempt + 1} failed: ${err.message}`);
        }
    }

    throw new Error(`AI processing failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip markdown code fences (```json ... ```) and parse JSON.
 */
function safeParseJSON(raw) {
    // Remove ```json ... ``` or ``` ... ``` wrappers the model sometimes adds
    const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

    return JSON.parse(cleaned);
}

/**
 * Validate that the AI output respects the structural contract:
 * - Must be an array
 * - Same length as input
 * - Each item preserves original index and timestamp
 */
function validateChunkOutput(original, output) {
    if (!Array.isArray(output)) {
        throw new Error("Output is not a JSON array");
    }
    if (output.length !== original.length) {
        throw new Error(
            `Output length mismatch: expected ${original.length}, got ${output.length}`,
        );
    }
    for (let i = 0; i < original.length; i++) {
        if (output[i].index !== original[i].index) {
            throw new Error(`index mismatch at position ${i}`);
        }
        if (output[i].timestamp !== original[i].timestamp) {
            throw new Error(`timestamp mismatch at position ${i} (index ${original[i].index})`);
        }
        if (typeof output[i].text !== "string") {
            throw new Error(`text field missing/invalid at position ${i}`);
        }
    }
}