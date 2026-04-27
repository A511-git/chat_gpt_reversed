/**
 * srtParser.js
 * Converts raw SRT file text into an array of structured subtitle blocks.
 *
 * Input (raw SRT):
 *   1
 *   00:00:01,000 --> 00:00:03,000
 *   Hello world
 *
 * Output:
 *   [{ index: 1, timestamp: "00:00:01,000 --> 00:00:03,000", text: "Hello world" }]
 */

/**
 * Parse a raw SRT string into structured subtitle blocks.
 * @param {string} srtText - Full raw SRT file content
 * @returns {{ index: number, timestamp: string, text: string }[]}
 */
export function parseSRT(srtText) {
    // Normalise line endings, then split on blank lines
    const rawBlocks = srtText
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim()
        .split(/\n{2,}/);

    const blocks = [];

    for (const raw of rawBlocks) {
        const lines = raw.trim().split("\n");
        if (lines.length < 3) continue; // malformed block – skip

        const index = parseInt(lines[0].trim(), 10);
        if (isNaN(index)) continue; // not a valid block number

        const timestamp = lines[1].trim();
        // Everything from line 3 onward is subtitle text (multi-line supported)
        const text = lines.slice(2).join("\n").trim();

        if (!timestamp.includes("-->")) continue; // sanity check

        blocks.push({ index, timestamp, text });
    }

    // Sort by index in case the file was out-of-order
    blocks.sort((a, b) => a.index - b.index);

    return blocks;
}

/**
 * Serialise structured blocks back to a valid SRT string.
 * @param {{ index: number, timestamp: string, text: string }[]} blocks
 * @returns {string}
 */
export function blocksToSRT(blocks) {
    return blocks
        .map((b) => `${b.index}\n${b.timestamp}\n${b.text}`)
        .join("\n\n")
        .concat("\n");
}