/**
 * chunker.js
 * Splits a flat array of subtitle blocks into ordered chunks.
 * Each chunk is sized between MIN_CHUNK_SIZE and MAX_CHUNK_SIZE blocks.
 */

const MIN_CHUNK_SIZE = 20;
const MAX_CHUNK_SIZE = 30;

/**
 * Split blocks into chunks.
 * @param {{ index: number, timestamp: string, text: string }[]} blocks
 * @param {number} [size=25] - Target chunk size (clamped to MIN/MAX)
 * @returns {{ index: number, status: string, retry: number, content: object[] }[]}
 */
export function chunkBlocks(blocks, size = 25) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, size));
    const chunks = [];

    for (let i = 0; i < blocks.length; i += chunkSize) {
        const content = blocks.slice(i, i + chunkSize);
        chunks.push({
            index: chunks.length,   // 0-based chunk position
            status: "pending",
            retry: 0,
            content,
        });
    }

    return chunks;
}