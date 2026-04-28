import { randomUUID } from "crypto";
import {
    generateFakeSentinelToken,
    simulateBypassHeaders,
    solveSentinelChallenge,
    getDeviceId,
    getSessionId,
} from "./utils.js";

export class ChatGPTReversed {
    static csrfToken = undefined;
    static deviceId = undefined;
    static sessionId = undefined;
    static initialized = false;

    constructor(options = {}) {
        if (ChatGPTReversed.initialized)
            throw new Error("ChatGPTReversed has already been initialized.");
        this.maintainSession = options.maintainSession ?? false;
        this.activeSession = null;
        this.initialize();
    }

    async initialize() {
        ChatGPTReversed.initialized = true;
        ChatGPTReversed.deviceId = getDeviceId();
        ChatGPTReversed.sessionId = getSessionId();
    }

    async createNewSession() {
        const uuid = randomUUID();
        const csrfToken = await this.getCSRFToken(uuid);
        const sentinelToken = await this.getSentinelToken(uuid, csrfToken);

        ChatGPTReversed.csrfToken = csrfToken;

        return {
            uuid,
            csrf: csrfToken,
            sentinel: sentinelToken,
        };
    }

    async resetSession() {
        if (this.maintainSession) {
            this.activeSession = null;
            ChatGPTReversed.csrfToken = undefined;
        }
    }

    async refreshSession() {
        if (this.maintainSession) {
            this.activeSession = null;
            ChatGPTReversed.csrfToken = undefined;
            ChatGPTReversed.deviceId = getDeviceId();
            ChatGPTReversed.sessionId = getSessionId();
            this.activeSession = await this.createNewSession();
        }
    }

    async rotateSessionData() {
        return this.createNewSession();
    }

    async getSession() {
        if (this.maintainSession && this.activeSession !== null) {
            return this.activeSession;
        }
        const newSession = await this.createNewSession();
        if (this.maintainSession) {
            this.activeSession = newSession;
        }
        return newSession;
    }

    async getCSRFToken(uuid) {
        if (ChatGPTReversed.csrfToken !== undefined) {
            return ChatGPTReversed.csrfToken;
        }

        const headers = await simulateBypassHeaders({
            accept: "application/json",
            spoofAddress: true,
            preOaiUUID: uuid,
            deviceId: ChatGPTReversed.deviceId,
            sessionId: ChatGPTReversed.sessionId,
        });

        const response = await fetch("https://chatgpt.com/api/auth/csrf", {
            method: "GET",
            headers,
        });

        const data = await response.json();
        if (data.csrfToken === undefined) {
            throw new Error("Failed to fetch required CSRF token");
        }
        return data.csrfToken;
    }

    async getSentinelToken(uuid, csrf) {
        const headers = await simulateBypassHeaders({
            accept: "application/json",
            spoofAddress: true,
            preOaiUUID: uuid,
            deviceId: ChatGPTReversed.deviceId,
            sessionId: ChatGPTReversed.sessionId,
        });

        const test = await generateFakeSentinelToken();

        const response = await fetch(
            "https://chatgpt.com/backend-anon/sentinel/chat-requirements",
            {
                body: JSON.stringify({ p: test }),
                headers: {
                    ...headers,
                    Cookie: `__Host-next-auth.csrf-token=${csrf}; oai-did=${uuid}; oai-nav-state=1;`,
                },
                method: "POST",
            }
        );

        const data = await response.json();
        if (data.token === undefined || data.proofofwork === undefined) {
            console.error("Sentinel response:", data);
            throw new Error("Failed to fetch required sentinel token");
        }

        const oaiSc = response.headers.get("set-cookie")?.split("oai-sc=")[1]?.split(";")[0] || "";
        if (!oaiSc) throw new Error("Failed to fetch required oai-sc token");

        const challengeToken = await solveSentinelChallenge(
            data.proofofwork.seed,
            data.proofofwork.difficulty
        );

        return {
            token: data.token,
            proof: challengeToken,
            oaiSc: oaiSc,
        };
    }

    async complete(message, options = {}) {
        const session = await this.getSession();

        const headers = await simulateBypassHeaders({
            accept: "text/event-stream",
            spoofAddress: true,
            preOaiUUID: session.uuid,
            deviceId: ChatGPTReversed.deviceId,
            sessionId: ChatGPTReversed.sessionId,
        });

        const messageID = randomUUID();
        const turnTraceId = randomUUID();

        // Extra headers from real browser
        const extraHeaders = {
            "OAI-Echo-Logs": "4,33329,5,33540,0,33549,1,38834",
            "x-oai-turn-trace-id": turnTraceId,
            "OAI-Telemetry": "[1,null]",
            "accept-encoding": "gzip, deflate, br",
        };

        const response = await fetch("https://chatgpt.com/backend-anon/conversation", {
            headers: {
                ...headers,
                ...extraHeaders,
                Cookie: `__Host-next-auth.csrf-token=${session.csrf}; oai-did=${session.uuid}; oai-nav-state=1; oai-sc=${session.sentinel.oaiSc};`,
                "openai-sentinel-chat-requirements-token": session.sentinel.token,
                "openai-sentinel-proof-token": session.sentinel.proof,
            },
            body: JSON.stringify({
                action: "next",
                messages: [
                    {
                        id: messageID,
                        author: { role: "user" },
                        create_time: Date.now() / 1000,
                        content: {
                            content_type: "text",
                            parts: [message],
                        },
                        metadata: {
                            selected_all_github_repos: false,
                            selected_github_repos: [],
                            serialization_metadata: { custom_symbol_offsets: [] },
                            dictation: false,
                        },
                    },
                ],
                parent_message_id: "client-created-root",
                model: "auto",
                timezone_offset_min: -330,
                timezone: "Asia/Calcutta",
                suggestions: [],
                history_and_training_disabled: true,
                conversation_mode: { kind: "primary_assistant" },
                system_hints: [],
                supports_buffering: true,
                supported_encodings: ["v1"],
                client_contextual_info: {
                    is_dark_mode: true,
                    time_since_loaded: 38,
                    page_height: 903,
                    page_width: 598,
                    pixel_ratio: 2,
                    screen_height: 1050,
                    screen_width: 1680,
                    app_name: "chatgpt.com",
                },
            }),
            method: "POST",
        });

        if (!response.ok) {
            let errorBody = "";
            try {
                errorBody = await response.text();
            } catch (e) { }
            throw new Error(`Request failed with status ${response.status}: ${errorBody.substring(0, 300)}`);
        }

        if (response.body === null) {
            throw new Error("No response body");
        }

        if (options.stream) {
            return this.streamResponse(response);
        }
        return this.collectFullResponse(response);
    }

    async collectFullResponse(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let result = "";
        let buffer = "";
        let finished = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const dataStr = line.replace("data:", "").trim();
                if (!dataStr || dataStr === "[DONE]") continue;

                try {
                    const json = JSON.parse(dataStr);
                    if (json.message?.content?.parts) {
                        result = json.message.content.parts[0];
                        if (json.message.status === "finished_successfully") finished = true;
                    } else if (json.o === "append" && json.p === "/message/content/parts/0") {
                        result += json.v;
                    } else if (Array.isArray(json.v)) {
                        for (const op of json.v) {
                            if (op.o === "append" && op.p === "/message/content/parts/0") result += op.v;
                            if (op.p === "/message/status" && op.o === "replace" && op.v === "finished_successfully") finished = true;
                        }
                    }
                } catch { }
            }
            if (finished) break;
        }
        return result;
    }

    async *streamResponse(response) {
        // unchanged – keep your existing streaming method
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let finished = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const dataStr = line.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") continue;
                let json;
                try { json = JSON.parse(dataStr); } catch { continue; }
                let deltaText = "";
                if (json.message?.content?.parts && typeof json.message.content.parts[0] === "string") {
                    const current = json.message.content.parts[0];
                    deltaText = current.startsWith(fullText) ? current.slice(fullText.length) : current;
                    fullText = current;
                    if (json.message.status === "finished_successfully") finished = true;
                } else if (json.o === "append" && json.p === "/message/content/parts/0") {
                    deltaText = json.v;
                    fullText += json.v;
                } else if (Array.isArray(json.v)) {
                    for (const op of json.v) {
                        if (op.o === "append" && op.p === "/message/content/parts/0") {
                            deltaText += op.v;
                            fullText += op.v;
                        }
                        if (op.p === "/message/status" && op.o === "replace" && op.v === "finished_successfully") finished = true;
                    }
                }
                if (json.type === "message_stream_complete") finished = true;
                if (deltaText) yield { text: deltaText, metadata: json.metadata || {} };
                if (finished) break;
            }
        }
    }
}