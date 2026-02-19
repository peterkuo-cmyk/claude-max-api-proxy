/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for client integration.
 * Uses direct delta streaming (each content_delta is written immediately).
 */
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { spawn as nodeSpawn } from "child_process";
import path from "path";
import fs from "fs";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import type { SubprocessOptions } from "../subprocess/manager.js";
import { openaiToCli, extractModel } from "../adapter/openai-to-cli.js";
import type { CliInput } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";

// ── Telegram Progress Reporter ─────────────────────────────────────
// Shows real-time progress updates in Telegram while the CLI runs
// tool calls (Bash, WebSearch, Read, etc.). Sends one message on the
// first tool call, then edits it on subsequent calls, and deletes it
// when the final response is ready.

const TOOL_LABELS: Record<string, string> = {
    "Bash":       "執行命令",
    "Read":       "讀取檔案",
    "Write":      "寫入檔案",
    "Edit":       "編輯檔案",
    "Grep":       "搜尋內容",
    "Glob":       "搜尋檔案",
    "WebSearch":  "搜尋網頁",
    "WebFetch":   "讀取網頁",
    "TodoRead":   "讀取待辦",
    "TodoWrite":  "更新待辦",
};

let _cachedBotToken: string | null | undefined = undefined;

function getTelegramBotToken(): string | null {
    if (_cachedBotToken !== undefined) return _cachedBotToken;
    try {
        const configPath = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        _cachedBotToken = config?.channels?.telegram?.botToken || null;
    } catch (err: any) {
        console.error("[ProgressReporter] Failed to read bot token:", err.message);
        _cachedBotToken = null;
    }
    return _cachedBotToken;
}

async function telegramApi(method: string, params: Record<string, unknown>): Promise<any> {
    const token = getTelegramBotToken();
    if (!token) return null;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        });
        const data: any = await resp.json();
        if (!data.ok) {
            console.error(`[TelegramAPI] ${method} failed:`, data.description);
        }
        return data;
    } catch (err: any) {
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
    private chatId: string | null;
    private messageId: number | null = null;
    private toolHistory: string[] = [];
    private lastUpdateAt = 0;
    private pendingLabel: string | null = null;
    private throttleTimer: ReturnType<typeof setTimeout> | null = null;
    private isDeleted = false;

    constructor(chatId: string | null) {
        this.chatId = chatId;
    }

    /**
     * Build the progress message text from tool history.
     */
    private _buildText(): string {
        if (this.toolHistory.length === 0) return "⏳ 處理中...";
        const lines = this.toolHistory.map((label, i) => {
            if (i === 0) return `⏳ ${label}...`;
            return `     ${label}...`;
        });
        return lines.join("\n");
    }

    /**
     * Report a new tool call. Sends or edits the progress message.
     */
    async report(toolName: string): Promise<void> {
        if (this.isDeleted || !this.chatId) return;
        const label = TOOL_LABELS[toolName] || toolName;
        if (this.toolHistory.length > 0 && this.toolHistory[this.toolHistory.length - 1] === label) return;
        this.toolHistory.push(label);
        if (this.toolHistory.length > 6) this.toolHistory = this.toolHistory.slice(-6);

        const now = Date.now();
        const elapsed = now - this.lastUpdateAt;
        if (elapsed >= ProgressReporter.MIN_UPDATE_INTERVAL) {
            await this._flush();
        } else {
            this.pendingLabel = label;
            if (!this.throttleTimer) {
                this.throttleTimer = setTimeout(async () => {
                    this.throttleTimer = null;
                    if (!this.isDeleted) await this._flush();
                }, ProgressReporter.MIN_UPDATE_INTERVAL - elapsed);
            }
        }
    }

    /**
     * Actually send or edit the Telegram message.
     */
    private async _flush(): Promise<void> {
        if (this.isDeleted) return;
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
        } else {
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
    async cleanup(): Promise<void> {
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
function notifyTelegram(message: string): void {
    const telegramId = process.env.TELEGRAM_NOTIFY_ID;
    if (!telegramId) return;

    const ocTool = path.join(process.env.HOME || "/tmp", ".openclaw", "bin", "oc-tool");
    try {
        const proc = nodeSpawn(ocTool, ["message", "send", JSON.stringify({
            channel: "telegram",
            target: `telegram:${telegramId}`,
            message,
        })], { env: { ...process.env }, stdio: "ignore", detached: true });
        proc.unref();
    } catch (err: any) {
        console.error("[notifyTelegram] Failed:", err.message);
    }
}

// ── Route Handlers ─────────────────────────────────────────────────

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming.
 */
export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
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
        const conversationId: string | undefined = body.user;
        let hasExistingSession = false;
        let claudeSessionId: string | undefined;

        if (conversationId) {
            const existing = sessionManager.get(conversationId);
            if (existing) {
                hasExistingSession = true;
                claudeSessionId = existing.claudeSessionId;
                existing.lastUsedAt = Date.now();
                sessionManager.save().catch((err) =>
                    console.error("[SessionManager] Save error:", err)
                );
                console.error(
                    `[Session] Resuming: ${conversationId} -> ${claudeSessionId}`
                );
            } else {
                claudeSessionId = sessionManager.getOrCreate(
                    conversationId,
                    extractModel(body.model)
                );
                console.error(
                    `[Session] New: ${conversationId} -> ${claudeSessionId}`
                );
            }
        }

        // Convert to CLI input format (only latest message if resuming)
        const cliInput = openaiToCli(body, hasExistingSession);

        // Build subprocess options with session info
        const subOpts: SubprocessOptions = {
            model: cliInput.model,
            systemPrompt: cliInput.systemPrompt,
        };
        if (hasExistingSession && claudeSessionId) {
            subOpts.resumeSessionId = claudeSessionId;
        } else if (claudeSessionId) {
            subOpts.sessionId = claudeSessionId;
        }

        const subprocess = new ClaudeSubprocess();

        // Handle resume failures: invalidate session so next request starts fresh
        subprocess.on("resume_failed", () => {
            console.error(
                `[Session] Resume failed, invalidating: ${conversationId}`
            );
            if (conversationId) sessionManager.delete(conversationId);
        });

        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, subOpts);
        } else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, subOpts);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
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
async function handleStreamingResponse(
    req: Request,
    res: Response,
    subprocess: ClaudeSubprocess,
    cliInput: CliInput,
    requestId: string,
    subOpts: SubprocessOptions
): Promise<void> {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");

    return new Promise<void>((resolve, reject) => {
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let isFirst = true;

        // Progress reporter for Telegram
        const telegramChatId = process.env.TELEGRAM_NOTIFY_ID || null;
        const progress = new ProgressReporter(telegramChatId);

        // Handle client disconnect
        res.on("close", () => {
            if (!isComplete) subprocess.kill();
            progress.cleanup().catch(() => {});
            resolve();
        });

        // Detect tool calls for progress reporting
        subprocess.on("message", (msg: any) => {
            if (msg.type !== "stream_event") return;
            const eventType = msg.event?.type;
            if (eventType === "content_block_start") {
                const block = msg.event.content_block;
                if (block?.type === "tool_use" && block.name) {
                    console.error(`[Stream] Tool call: ${block.name}`);
                    progress.report(block.name).catch(() => {});
                }
            }
        });

        // Stream each content delta directly to the client
        subprocess.on("content_delta", (event: any) => {
            const text = event.event.delta?.text || "";
            if (!text || res.writableEnded) return;

            const chunk = {
                id: `chatcmpl-${requestId}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: lastModel,
                choices: [{
                    index: 0,
                    delta: {
                        role: isFirst ? ("assistant" as const) : undefined,
                        content: text,
                    },
                    finish_reason: null,
                }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            isFirst = false;
        });

        // Track model name from assistant messages
        subprocess.on("assistant", (message: any) => {
            lastModel = message.message.model;
        });

        subprocess.on("result", (_result: any) => {
            isComplete = true;
            // Clean up progress message before sending final response
            progress.cleanup().catch(() => {});
            if (!res.writableEnded) {
                // Send final done chunk with finish_reason
                const doneChunk = createDoneChunk(requestId, lastModel);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });

        subprocess.on("error", (error: Error) => {
            console.error("[Streaming] Error:", error.message);
            // Clean up progress message
            progress.cleanup().catch(() => {});
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

        subprocess.on("close", (code: number | null) => {
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
async function handleNonStreamingResponse(
    res: Response,
    subprocess: ClaudeSubprocess,
    cliInput: CliInput,
    requestId: string,
    subOpts: SubprocessOptions
): Promise<void> {
    return new Promise<void>((resolve) => {
        let finalResult: any = null;

        subprocess.on("result", (result) => {
            finalResult = result;
        });

        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            if (error.message.includes("timed out")) {
                notifyTelegram(`⚠️ 任務超時被終止：${error.message}`);
            }
            res.status(500).json({
                error: { message: error.message, type: "server_error", code: null },
            });
            resolve();
        });

        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            } else if (!res.headersSent) {
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
export function handleModels(_req: Request, res: Response): void {
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-haiku-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
        ],
    });
}

/**
 * Handle GET /health — Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
