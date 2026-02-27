import { v4 as uuidv4 } from "uuid";
import { spawn as nodeSpawn } from "child_process";
import path from "path";
import fs from "fs";
// ── Active Request Tracker ────────────────────────────────────────
// Tracks all in-flight CLI requests so /health can report IDLE vs BUSY
const activeRequests = new Map();
function registerRequest(id, model, conversationId = null, isSubagent = false) {
    activeRequests.set(id, {
        startedAt: Date.now(),
        model,
        lastTool: null,
        toolHistory: [],
        conversationId,
        isSubagent,
    });
}
function trackTool(id, toolName) {
    const req = activeRequests.get(id);
    if (!req) return;
    req.lastTool = toolName;
    if (req.toolHistory[req.toolHistory.length - 1] !== toolName) {
        req.toolHistory.push(toolName);
        if (req.toolHistory.length > 20) req.toolHistory = req.toolHistory.slice(-20);
    }
}
function unregisterRequest(id) {
    const req = activeRequests.get(id);
    if (req?.isSubagent && req?.conversationId) {
        const mutex = subagentMutexes.get(req.conversationId);
        if (mutex) mutex.release();
    }
    activeRequests.delete(id);
}
function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
}
// ── Auto-Subagent ─────────────────────────────────────────────────
// Routes new messages to a subagent when main agent is busy >30s.
// Max 2 concurrent agents per conversation: main + 1 subagent.
const SUBAGENT_BUSY_THRESHOLD = 30_000;
const SUBAGENT_CWD = path.join(process.env.HOME || "/tmp", ".openclaw", "workspace-subagent");
try { fs.mkdirSync(SUBAGENT_CWD, { recursive: true }); } catch {}
const subagentSessions = new Map();
// key: conversationId → { subConvId, createdAt, lastUsedAt, requestCount, active, mainToolHistory }
// Simple mutex per subConvId to serialize subagent requests
const subagentMutexes = new Map();
class SubagentMutex {
    constructor() { this._locked = false; this._waiters = []; }
    acquire() {
        if (!this._locked) { this._locked = true; return Promise.resolve(); }
        return new Promise(resolve => { this._waiters.push(resolve); });
    }
    release() {
        if (this._waiters.length > 0) { this._waiters.shift()(); }
        else { this._locked = false; }
    }
}
function findBusyMainRequest(conversationId) {
    const now = Date.now();
    for (const [, info] of activeRequests) {
        if (info.conversationId === conversationId && !info.isSubagent &&
            (now - info.startedAt) > SUBAGENT_BUSY_THRESHOLD) {
            return { ...info, elapsed: now - info.startedAt };
        }
    }
    return null;
}
function findActiveSubagentRequest(subConvId) {
    for (const [, info] of activeRequests) {
        if (info.conversationId === subConvId && info.isSubagent) {
            return { ...info, elapsed: Date.now() - info.startedAt };
        }
    }
    return null;
}
function getOrCreateSubagentSession(conversationId, mainReq) {
    const subConvId = `${conversationId}::subagent`;
    let session = subagentSessions.get(conversationId);
    if (!session) {
        session = { subConvId, createdAt: Date.now(), lastUsedAt: Date.now(),
                     requestCount: 0, active: true, mainToolHistory: mainReq.toolHistory || [] };
        subagentSessions.set(conversationId, session);
    } else {
        session.lastUsedAt = Date.now();
        session.active = true;
        session.mainToolHistory = mainReq.toolHistory || [];
    }
    return session;
}
function deactivateSubagentSession(conversationId) {
    const session = subagentSessions.get(conversationId);
    if (session) session.active = false;
}
function getSubagentMutex(subConvId) {
    let mutex = subagentMutexes.get(subConvId);
    if (!mutex) { mutex = new SubagentMutex(); subagentMutexes.set(subConvId, mutex); }
    return mutex;
}
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli, extractModel, stripAssistantBleed } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, parseToolCalls, createToolCallChunks } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
// ── Telegram Progress Reporter ─────────────────────────────────────
// Shows real-time progress updates in Telegram while the CLI runs
// tool calls (Bash, WebSearch, Read, etc.). Sends one message on the
// first tool call, then edits it on subsequent calls, and deletes it
// when the final response is ready.
const TOOL_LABELS = {
    "Bash": "執行命令",
    "Read": "讀取檔案",
    "Write": "寫入檔案",
    "Edit": "編輯檔案",
    "Grep": "搜尋內容",
    "Glob": "搜尋檔案",
    "WebSearch": "搜尋網頁",
    "WebFetch": "讀取網頁",
    "TodoRead": "讀取待辦",
    "TodoWrite": "更新待辦",
};
let _cachedBotToken = undefined;
function getTelegramBotToken() {
    if (_cachedBotToken !== undefined)
        return _cachedBotToken;
    try {
        const configPath = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        _cachedBotToken = config?.channels?.telegram?.botToken || null;
    }
    catch (err) {
        console.error("[ProgressReporter] Failed to read bot token:", err.message);
        _cachedBotToken = null;
    }
    return _cachedBotToken;
}
async function telegramApi(method, params) {
    const token = getTelegramBotToken();
    if (!token)
        return null;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        const data = await resp.json();
        if (!data.ok) {
            console.error(`[TelegramAPI] ${method} failed:`, data.description);
        }
        return data;
    }
    catch (err) {
        console.error(`[TelegramAPI] ${method} error:`, err.message);
        return null;
    }
}
/**
 * Manages a single Telegram progress message that gets updated as
 * the CLI calls different tools. One instance per request.
 */
class ProgressReporter {
    static MIN_UPDATE_INTERVAL = 3000; // 3s between edits
    chatId;
    messageId = null;
    toolHistory = [];
    lastUpdateAt = 0;
    pendingLabel = null;
    throttleTimer = null;
    isDeleted = false;
    constructor(chatId) {
        this.chatId = chatId;
    }
    /**
     * Build the progress message text from tool history.
     */
    _buildText() {
        if (this.toolHistory.length === 0)
            return "⏳ 處理中...";
        const lines = this.toolHistory.map((label, i) => {
            if (i === 0)
                return `⏳ ${label}...`;
            return `     ${label}...`;
        });
        return lines.join("\n");
    }
    /**
     * Report a new tool call. Sends or edits the progress message.
     */
    async report(toolName) {
        if (this.isDeleted || !this.chatId)
            return;
        const label = TOOL_LABELS[toolName] || toolName;
        if (this.toolHistory.length > 0 && this.toolHistory[this.toolHistory.length - 1] === label)
            return;
        this.toolHistory.push(label);
        if (this.toolHistory.length > 6)
            this.toolHistory = this.toolHistory.slice(-6);
        const now = Date.now();
        const elapsed = now - this.lastUpdateAt;
        if (elapsed >= ProgressReporter.MIN_UPDATE_INTERVAL) {
            await this._flush();
        }
        else {
            this.pendingLabel = label;
            if (!this.throttleTimer) {
                this.throttleTimer = setTimeout(async () => {
                    this.throttleTimer = null;
                    if (!this.isDeleted)
                        await this._flush();
                }, ProgressReporter.MIN_UPDATE_INTERVAL - elapsed);
            }
        }
    }
    /**
     * Actually send or edit the Telegram message.
     */
    async _flush() {
        if (this.isDeleted)
            return;
        this.lastUpdateAt = Date.now();
        this.pendingLabel = null;
        const text = this._buildText();
        if (!this.messageId) {
            const result = await telegramApi("sendMessage", {
                chat_id: this.chatId,
                text,
                disable_notification: true,
            });
            if (result?.ok) {
                this.messageId = result.result.message_id;
                console.error(`[ProgressReporter] Sent progress message #${this.messageId}`);
            }
        }
        else {
            await telegramApi("editMessageText", {
                chat_id: this.chatId,
                message_id: this.messageId,
                text,
            });
        }
    }
    /**
     * Clean up: delete the progress message when the final response arrives.
     */
    async cleanup() {
        this.isDeleted = true;
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        if (this.messageId && this.chatId) {
            await telegramApi("deleteMessage", {
                chat_id: this.chatId,
                message_id: this.messageId,
            });
            console.error(`[ProgressReporter] Deleted progress message #${this.messageId}`);
        }
    }
}
/**
 * Send a notification message to Telegram via oc-tool.
 * Fire-and-forget — errors are logged but don't affect the caller.
 */
function notifyTelegram(message) {
    const telegramId = process.env.TELEGRAM_NOTIFY_ID;
    if (!telegramId)
        return;
    const ocTool = path.join(process.env.HOME || "/tmp", ".openclaw", "bin", "oc-tool");
    try {
        const proc = nodeSpawn(ocTool, ["message", "send", JSON.stringify({
                channel: "telegram",
                target: `telegram:${telegramId}`,
                message,
            })], { env: { ...process.env }, stdio: "ignore", detached: true });
        proc.unref();
    }
    catch (err) {
        console.error("[notifyTelegram] Failed:", err.message);
    }
}
// ── Route Handlers ─────────────────────────────────────────────────
/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming.
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Session management: determine if we should resume an existing session
        const conversationId = body.user;
        // ── Auto-Subagent routing decision ────────────────────────────
        let effectiveConversationId = conversationId;
        let isSubagentRequest = false;
        let subagentSession = null;
        if (conversationId) {
            const mainBusyReq = findBusyMainRequest(conversationId);
            if (mainBusyReq) {
                const subConvId = `${conversationId}::subagent`;
                subagentSession = getOrCreateSubagentSession(conversationId, mainBusyReq);
                const subBusyReq = findActiveSubagentRequest(subConvId);
                if (subBusyReq) {
                    // Both main and subagent busy → notify, then wait for subagent
                    const mainElapsed = formatElapsed(mainBusyReq.elapsed);
                    const subElapsed = formatElapsed(subBusyReq.elapsed);
                    notifyTelegram(
                        `⚠️ 主代理和副代理都在忙碌中\n` +
                        `🔹 主代理：${mainBusyReq.toolHistory.join(' → ') || '處理中'} (${mainElapsed})\n` +
                        `🔹 副代理：${subBusyReq.toolHistory.join(' → ') || '處理中'} (${subElapsed})\n` +
                        `你的訊息會在副代理完成後處理。`
                    );
                } else {
                    // Only main busy → activate subagent
                    notifyTelegram(
                        `🔀 主代理忙碌中（已 ${formatElapsed(mainBusyReq.elapsed)}），副代理已啟動處理你的訊息`
                    );
                }
                // Serialize subagent requests — wait if subagent is already processing
                const mutex = getSubagentMutex(subConvId);
                await mutex.acquire();
                effectiveConversationId = subConvId;
                isSubagentRequest = true;
                subagentSession.requestCount++;
                console.error(`[AutoSubagent] Routing to subagent: ${conversationId} → ${subConvId} (request #${subagentSession.requestCount})`);
            } else {
                // Main is not busy — deactivate subagent routing
                deactivateSubagentSession(conversationId);
            }
        }
        // ── Session lookup using effectiveConversationId ──────────────
        let hasExistingSession = false;
        let claudeSessionId;
        if (effectiveConversationId) {
            const existing = sessionManager.get(effectiveConversationId);
            if (existing) {
                hasExistingSession = true;
                claudeSessionId = existing.claudeSessionId;
                existing.lastUsedAt = Date.now();
                sessionManager.save().catch((err) => console.error("[SessionManager] Save error:", err));
                console.error(`[Session] Resuming: ${effectiveConversationId} -> ${claudeSessionId}`);
            }
            else {
                claudeSessionId = sessionManager.getOrCreate(effectiveConversationId, extractModel(body.model));
                console.error(`[Session] New: ${effectiveConversationId} -> ${claudeSessionId}`);
            }
        }
        // Convert to CLI input format (only latest message if resuming)
        const cliInput = openaiToCli(body, hasExistingSession);
        // ── Subagent system prompt injection ──────────────────────────
        if (isSubagentRequest && subagentSession) {
            const mainReq = findBusyMainRequest(conversationId);
            const elapsed = mainReq ? formatElapsed(mainReq.elapsed) : '30s+';
            const tools = mainReq?.toolHistory?.join(' → ') || '處理中';
            const preamble = `\n\n## IMPORTANT: 你是臨時副代理\n` +
                `主代理目前正在忙碌（已執行 ${elapsed}，工具：${tools}）。\n` +
                `你負責處理使用者的新需求。你擁有完整工具能力。\n` +
                `工作目錄：~/.openclaw/workspace-subagent/（與主代理隔離）。\n`;
            if (cliInput.systemPrompt) {
                cliInput.systemPrompt = preamble + '\n' + cliInput.systemPrompt;
            } else {
                cliInput.systemPrompt = preamble;
            }
        }
        // Build subprocess options with session info
        const subOpts = {
            model: cliInput.model,
            systemPrompt: cliInput.systemPrompt,
        };
        if (isSubagentRequest) {
            subOpts.cwd = SUBAGENT_CWD;
        }
        if (hasExistingSession && claudeSessionId) {
            subOpts.resumeSessionId = claudeSessionId;
        }
        else if (claudeSessionId) {
            subOpts.sessionId = claudeSessionId;
        }
        const subprocess = new ClaudeSubprocess();
        // Register this request for /health tracking
        registerRequest(requestId, extractModel(body.model), effectiveConversationId, isSubagentRequest);
        // Handle resume failures: invalidate session so next request starts fresh
        subprocess.on("resume_failed", () => {
            console.error(`[Session] Resume failed, invalidating: ${effectiveConversationId}`);
            if (effectiveConversationId)
                sessionManager.delete(effectiveConversationId);
        });
        // External tool calling: present and not explicitly disabled
        const hasTools = Array.isArray(body.tools) &&
            body.tools.length > 0 &&
            body.tool_choice !== "none";
        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts, hasTools);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts);
        }
    }
    catch (error) {
        unregisterRequest(requestId);
        const message = error instanceof Error ? error.message : "Unknown error";
        const stack = error instanceof Error ? error.stack : "";
        console.error("[handleChatCompletions] Error:", message);
        console.error("[handleChatCompletions] Stack:", stack);
        if (!res.headersSent) {
            res.status(500).json({
                error: { message, type: "server_error", code: null },
            });
        }
    }
}
/**
 * Handle streaming response (SSE)
 *
 * Each content_delta event is immediately written to the response stream.
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts, hasTools = false) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    return new Promise((resolve, reject) => {
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let isFirst = true;
        // ── Bleed detection state ──────────────────────────────────
        // We accumulate streamed text to detect [User]/[Human] bleed patterns.
        // Once a bleed sentinel is detected, we stop forwarding further deltas.
        let accumulated = "";
        let bleedDetected = false;
        // Longest sentinel we watch for, so we know how much tail to hold back
        const BLEED_SENTINELS = ["\n[User]", "\n[Human]", "\nHuman:"];
        const MAX_SENTINEL_LEN = Math.max(...BLEED_SENTINELS.map((s) => s.length));
        /**
         * Write a delta chunk to the SSE stream.
         */
        function writeDelta(text) {
            if (!text || res.writableEnded)
                return;
            const chunk = {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: lastModel,
                choices: [{
                        index: 0,
                        delta: {
                            role: isFirst ? "assistant" : undefined,
                            content: text,
                        },
                        finish_reason: null,
                    }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            isFirst = false;
        }
        /**
         * Process an incoming delta with bleed detection.
         * We keep a tail buffer (MAX_SENTINEL_LEN chars) unwritten until we're
         * sure it doesn't start a bleed pattern — this prevents partial sentinels
         * (split across two deltas) from leaking through.
         */
        function processDelta(incoming) {
            if (bleedDetected || res.writableEnded)
                return;
            accumulated += incoming;
            // Check if the accumulated text contains a bleed sentinel
            const safe = stripAssistantBleed(accumulated);
            if (safe.length < accumulated.length) {
                // Bleed found — write the safe portion and stop
                bleedDetected = true;
                // Only write the part we haven't written yet
                const alreadyWritten = accumulated.length - incoming.length;
                const safeNew = safe.slice(alreadyWritten);
                if (safeNew)
                    writeDelta(safeNew);
                console.error("[Stream] Bleed detected — halting delta stream");
                return;
            }
            // No bleed yet, but hold back the last MAX_SENTINEL_LEN chars as a
            // look-ahead buffer in case a sentinel straddles two delta chunks.
            const safeLen = Math.max(0, accumulated.length - MAX_SENTINEL_LEN);
            const alreadyFlushed = accumulated.length - incoming.length;
            const toFlush = safeLen - alreadyFlushed;
            if (toFlush > 0) {
                writeDelta(accumulated.slice(alreadyFlushed, alreadyFlushed + toFlush));
            }
        }
        /**
         * Flush remaining buffered tail at end of stream.
         * Run through stripAssistantBleed one more time for safety.
         */
        function flushTail() {
            if (bleedDetected || res.writableEnded)
                return;
            const alreadyFlushed = Math.max(0, accumulated.length - MAX_SENTINEL_LEN);
            const tail = accumulated.slice(alreadyFlushed);
            if (!tail)
                return;
            const safe = stripAssistantBleed(accumulated).slice(alreadyFlushed);
            if (safe)
                writeDelta(safe);
        }
        // ──────────────────────────────────────────────────────────
        // Progress reporter for Telegram
        const telegramChatId = process.env.TELEGRAM_NOTIFY_ID || null;
        const progress = new ProgressReporter(telegramChatId);
        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete)
                subprocess.kill();
            progress.cleanup().catch(() => { });
            resolve();
        });
        // Detect tool calls for progress reporting + /health tracking
        subprocess.on("message", (msg) => {
            if (msg.type !== "stream_event")
                return;
            const eventType = msg.event?.type;
            if (eventType === "content_block_start") {
                const block = msg.event.content_block;
                if (block?.type === "tool_use" && block.name) {
                    console.error(`[Stream] Tool call: ${block.name}`);
                    progress.report(block.name).catch(() => { });
                    trackTool(requestId, block.name);
                }
            }
        });
        // Track model name from assistant messages
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
        });
        if (hasTools) {
            // ── Tool mode: buffer full response, parse tool calls at the end ──
            // We cannot stream incrementally because <tool_call> markers may span
            // multiple delta chunks. Buffer everything and emit synthesized chunks.
            let toolBuffer = "";
            subprocess.on("content_delta", (event) => {
                toolBuffer += event.event.delta?.text || "";
            });
            subprocess.on("result", (_result) => {
                isComplete = true;
                unregisterRequest(requestId);
                progress.cleanup().catch(() => { });
                // Apply bleed strip then parse tool calls
                const safeText = stripAssistantBleed(toolBuffer);
                const { hasToolCalls, toolCalls, textWithoutToolCalls } = parseToolCalls(safeText);
                if (!res.writableEnded) {
                    if (hasToolCalls) {
                        // Emit synthesized tool call SSE chunks
                        const chunks = createToolCallChunks(toolCalls, requestId, lastModel);
                        for (const chunk of chunks) {
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    }
                    else {
                        // No tool calls — emit full text as a single content chunk
                        if (textWithoutToolCalls) {
                            writeDelta(textWithoutToolCalls);
                        }
                        const doneChunk = createDoneChunk(requestId, lastModel);
                        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                resolve();
            });
        }
        else {
            // ── Normal mode: stream deltas through bleed detection ────────────
            subprocess.on("content_delta", (event) => {
                const text = event.event.delta?.text || "";
                if (!text)
                    return;
                processDelta(text);
            });
            subprocess.on("result", (_result) => {
                isComplete = true;
                unregisterRequest(requestId);
                // Flush any buffered tail through bleed detection before finishing
                flushTail();
                // Clean up progress message before sending final response
                progress.cleanup().catch(() => { });
                if (!res.writableEnded) {
                    // Send final done chunk with finish_reason
                    const doneChunk = createDoneChunk(requestId, lastModel);
                    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                resolve();
            });
        }
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            unregisterRequest(requestId);
            // Clean up progress message
            progress.cleanup().catch(() => { });
            // Notify via Telegram if it's a timeout
            if (error.message.includes("timed out")) {
                notifyTelegram(`⚠️ 任務超時被終止：${error.message}`);
            }
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            unregisterRequest(requestId);
            // Subprocess exited - ensure response is closed
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    // Abnormal exit without result - send error
                    res.write(`data: ${JSON.stringify({
                        error: {
                            message: `Process exited with code ${code}`,
                            type: "server_error",
                            code: null,
                        },
                    })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess with session-aware options
        subprocess.start(cliInput.prompt, subOpts).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
    });
}
/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts) {
    return new Promise((resolve) => {
        let finalResult = null;
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            unregisterRequest(requestId);
            if (error.message.includes("timed out")) {
                notifyTelegram(`⚠️ 任務超時被終止：${error.message}`);
            }
            res.status(500).json({
                error: { message: error.message, type: "server_error", code: null },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            unregisterRequest(requestId);
            if (finalResult) {
                // Strip any [User]/[Human] bleed from the final result text
                finalResult = {
                    ...finalResult,
                    result: stripAssistantBleed(finalResult.result ?? ""),
                };
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        // Start the subprocess with session-aware options
        subprocess.start(cliInput.prompt, subOpts).catch((error) => {
            res.status(500).json({
                error: { message: error.message, type: "server_error", code: null },
            });
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models — Returns available models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-haiku-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
        ],
    });
}
/**
 * Handle GET /health — Health check endpoint with CLI status
 */
export function handleHealth(_req, res) {
    const now = Date.now();
    const requests = [];
    for (const [id, info] of activeRequests) {
        requests.push({
            id,
            model: info.model,
            elapsed: formatElapsed(now - info.startedAt),
            lastTool: info.lastTool,
            toolHistory: info.toolHistory,
            conversationId: info.conversationId,
            isSubagent: info.isSubagent,
        });
    }
    const busy = requests.length > 0;
    // Subagent sessions info
    const subagents = [];
    for (const [convId, session] of subagentSessions) {
        subagents.push({
            conversationId: convId,
            subConvId: session.subConvId,
            active: session.active,
            createdAt: new Date(session.createdAt).toISOString(),
            lastUsedAt: new Date(session.lastUsedAt).toISOString(),
            requestCount: session.requestCount,
            age: formatElapsed(now - session.createdAt),
        });
    }
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
        cli: {
            state: busy ? "busy" : "idle",
            activeRequests: requests.length,
            requests,
        },
        subagentSessions: subagents,
    });
}
//# sourceMappingURL=routes.js.map