/**
 * chunker.js
 *
 * MAX_LINES_PER_CHUNK reduced from 25 → 10.
 *
 * At 25 lines the model was consistently skipping ~half the lines even
 * with numbered format. At 10 lines the full output fits easily within
 * the model's comfortable range and refusal/compression drops sharply.
 * The retry mechanism in aiProcessor handles any remaining gaps.
 */

const MAX_LINES_PER_CHUNK = 10;

function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

export function dynamicChunkBlocks(blocks, contextSummary) {
    const MAX_CONTEXT_TOKENS = 12000;
    const RESERVED_OUTPUT    = 2000;
    const RESERVED_PROMPT    = 1500;

    const contextTokens   = estimateTokens(contextSummary);
    const availableTokens =
        MAX_CONTEXT_TOKENS - RESERVED_OUTPUT - RESERVED_PROMPT - contextTokens;

    const chunks      = [];
    let currentChunk  = [];
    let currentTokens = 0;

    for (const block of blocks) {
        const tokens = estimateTokens(block.text);

        const tokensFull = currentTokens + tokens > availableTokens;
        const linesFull  = currentChunk.length >= MAX_LINES_PER_CHUNK;

        if ((tokensFull || linesFull) && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk  = [];
            currentTokens = 0;
        }

        currentChunk.push(block);
        currentTokens += tokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}