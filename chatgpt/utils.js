import { randomUUID, randomInt, createHash } from "crypto";

export const randomIP = async () =>
    Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)).join(".");

export const _randomUUID = () => randomUUID().toString();

const simulated = {
    agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    platform: "Windows",
    mobile: "?0",
    ua: '"Not A(Brand";v="8", "Chromium";v="134", "Google Chrome";v="134"',
};

// Helper: random device ID
export function getDeviceId() {
    return randomUUID();
}

// Helper: random session ID
export function getSessionId() {
    return randomUUID();
}

export async function simulateBypassHeaders({
    accept,
    spoofAddress = false,
    preOaiUUID,
    deviceId,
    sessionId,
}) {
    const ip = await randomIP();
    const uuid = preOaiUUID || _randomUUID();
    const device = deviceId || randomUUID();
    const session = sessionId || randomUUID();

    const headers = {
        accept: accept || "application/json",
        "Content-Type": "application/json",
        "cache-control": "no-cache",
        Referer: "https://chatgpt.com/",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "oai-device-id": device,
        "oai-language": "en-US",
        "User-Agent": simulated.agent,
        pragma: "no-cache",
        priority: "u=1, i",
        "sec-ch-ua": `"${simulated.ua}"`,
        "sec-ch-ua-mobile": simulated.mobile,
        "sec-ch-ua-platform": `"${simulated.platform}"`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "OAI-Session-Id": session,
        "OAI-Client-Version": "prod-645fdc91b0342f46fd22f14352e47556b8590f03",
        "OAI-Client-Build-Number": "6209294",
    };

    if (spoofAddress) {
        Object.assign(headers, {
            "X-Forwarded-For": ip,
            "X-Originating-IP": ip,
            "X-Remote-IP": ip,
            "X-Remote-Addr": ip,
            "X-Host": ip,
            "X-Forwarded-Host": ip,
            Forwarded: `for=${ip}`,
            "True-Client-IP": ip,
            "X-Real-IP": ip,
        });
    }

    return headers;
}

// Real proof‑of‑work solver – matches browser output exactly
export async function solveSentinelChallenge(seed, difficulty) {
    const cores = [8, 12, 16, 24];
    const screens = [3000, 4000, 6000];
    const core = cores[randomInt(0, cores.length)];
    const screen = screens[randomInt(0, screens.length)];

    const now = new Date(Date.now() - 8 * 3600 * 1000);
    const parseTime = now.toUTCString().replace("GMT", "GMT+0100 (Central European Time)");

    const config = [core + screen, parseTime, 4294705152, 0, simulated.agent];

    const diffLen = difficulty.length / 2;

    for (let i = 0; i < 200000; i++) {
        config[3] = i;
        const jsonData = JSON.stringify(config);
        const base = Buffer.from(jsonData).toString("base64");
        const hashValue = createHash("sha3-512")
            .update(seed + base)
            .digest();

        if (hashValue.toString("hex").substring(0, diffLen) <= difficulty) {
            // Add the extra fields that real browser includes
            const extra = [
                "https://accounts.google.com/gsi/client",
                "prod-645fdc91b0342f46fd22f14352e47556b8590f03",
                "en-US",
                "en-US",
                6,
                "mediaDevices",
                "__reactContainer$dpj4h6hv1lk",
                "onbeforexrselect",
                10899.5,
                randomUUID(),
                "",
                12,
                Date.now(),
                0, 0, 0, 0, 0, 0, 0, 0
            ];
            const fullConfig = config.concat(extra);
            const fullBase = Buffer.from(JSON.stringify(fullConfig)).toString("base64");
            return "gAAAAAB" + fullBase + "~S";
        }
    }

    // Fallback (should rarely happen)
    const fallbackBase = Buffer.from(JSON.stringify([seed])).toString("base64");
    return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase + "~S";
}

export async function generateFakeSentinelToken() {
    const prefix = "gAAAAAC";
    const config = [
        randomInt(3000, 6000),
        new Date().toUTCString().replace("GMT", "GMT+0100 (Central European Time)"),
        4294705152,
        0,
        simulated.agent,
        "de",
        "de",
        401,
        "mediaSession",
        "location",
        "scrollX",
        (Math.random() * (5000 - 1000) + 1000).toFixed(4),
        randomUUID(),
        "",
        12,
        Date.now(),
    ];
    const base64 = Buffer.from(JSON.stringify(config)).toString("base64");
    return prefix + base64;
}