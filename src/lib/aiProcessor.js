/**
 * aiProcessor.js
 *
 * - Phase 1: generate context summary from full SRT (stateless, plain text)
 * - Phase 2: process chunks using raw SRT format (preserves indexes & timestamps)
 * - Uses persistent conversation per job (completeInConversation)
 */

import { ChatGPTReversed } from "../chatgptreversed/index.js";
import { parseSRT, blocksToSRT } from "./srtParser.js";
import fs from "fs/promises";

const chatgpt = new ChatGPTReversed({ maintainSession: true });

const MAX_SRT_RETRIES = 3;

// ─── Logger ───────────────────────────────────────────────────────────────────
async function logToFile(data) {
    const time = new Date().toISOString();
    await fs.appendFile("log.txt", `\n\n[${time}]\n${data}\n`).catch(() => { });
}

// ─── AI call with exponential backoff for rate limits (stateless) ────────────
async function callAI(prompt) {
    const MAX_BACKOFF_ATTEMPTS = 4;
    let delay = 5000;

    for (let attempt = 1; attempt <= MAX_BACKOFF_ATTEMPTS; attempt++) {
        try {
            return await chatgpt.complete(prompt);
        } catch (err) {
            const is429 = err?.message?.includes("429");
            if (is429 && attempt < MAX_BACKOFF_ATTEMPTS) {
                await logToFile(`=== 429 — waiting ${delay}ms ===`);
                console.warn(`[ai] 429 — waiting ${delay}ms (attempt ${attempt})`);
                await sleep(delay);
                delay *= 2;
            } else {
                throw err;
            }
        }
    }
}

// ─── Phase 1: Context Pass (stateless) ───────────────────────────────────────
export async function generateContextSummary(fullSrtText) {
    const prompt = `Summarize in 50 words: language used, vocabulary level, speaking style.\n\n${fullSrtText.slice(0, 2000)}`;
    const response = await callAI(prompt);
    await logToFile(`=== CONTEXT SUMMARY ===\n${response}`);
    return response.trim();
}

// ─── Phase 2: Chunk processing using raw SRT format ──────────────────────────
export async function processChunkWithConversation(blocks, conversationId, parentMessageId, instruction) {
    // Convert blocks to raw SRT text
    const inputSrt = blocksToSRT(blocks);
    await logToFile(`=== CHUNK conversation ${conversationId} (${blocks.length} blocks) ===\n${inputSrt}`);

    // First message of the conversation includes the instruction
    let message = inputSrt;
    if (parentMessageId === "client-created-root") {
        message = `${instruction}\n\nReturn the EXACT same SRT structure (index numbers, timestamps, block order) but with the subtitle text edited according to the instruction. Preserve all timestamps and index numbers. Output ONLY valid SRT text, no extra commentary or markdown.\n\n${inputSrt}`;
    }

    let response;
    let lastError;
    for (let attempt = 1; attempt <= MAX_SRT_RETRIES; attempt++) {
        try {
            response = await chatgpt.completeInConversation(message, {
                conversationId,
                parentMessageId,
            });
            break;
        } catch (err) {
            lastError = err;
            if (err.message.includes("429")) {
                await new Promise(r => setTimeout(r, 5000 * attempt));
            } else {
                break;
            }
        }
    }
    if (!response) throw lastError;

    const { text: rawSrt, messageId: newParentId } = response;
    await logToFile(`=== RAW SRT RESPONSE ===\n${rawSrt}`);

    // Parse the returned SRT text into blocks
    let processedBlocks;
    try {
        processedBlocks = parseSRT(rawSrt);
    } catch (e) {
        throw new Error(`Failed to parse returned SRT: ${e.message}`);
    }

    // Validate number of blocks
    if (processedBlocks.length !== blocks.length) {
        throw new Error(`Block count mismatch: expected ${blocks.length}, got ${processedBlocks.length}`);
    }

    // Ensure index numbers match the original (model may renumber from 1, we re-map)
    // We'll map based on order: assume the model returned blocks in the same sequence.
    // Restore original indexes and timestamps to be absolutely safe.
    const finalBlocks = processedBlocks.map((block, idx) => ({
        index: blocks[idx].index,
        timestamp: blocks[idx].timestamp,   // keep original timestamps (model sometimes changes comma to period)
        text: block.text,
    }));

    return { processedBlocks: finalBlocks, newParentMessageId: newParentId };
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}