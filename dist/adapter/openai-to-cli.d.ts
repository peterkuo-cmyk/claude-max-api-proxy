/**
 * Converts OpenAI chat request format to Claude CLI input
 */
import type { OpenAIChatRequest, OpenAIChatMessage } from "../types/openai.js";
export type ClaudeModel = "opus" | "sonnet" | "haiku" | string;
export interface CliInput {
    prompt: string;
    model: ClaudeModel;
    systemPrompt: string | null;
    sessionId?: string;
    isResuming?: boolean;
}
/**
 * Extract Claude CLI --model value from request model string.
 * Strips provider prefixes (maxproxy/, claude-code-cli/) before lookup.
 * Falls back to "opus" for unrecognized models.
 */
export declare function extractModel(model: string): ClaudeModel;
/**
 * Extract system prompt from messages (returned separately for --system-prompt flag).
 * Sanitizes OpenClaw's NO_REPLY/Heartbeat/Tooling directives, then appends
 * CLI tool instructions.
 */
export declare function extractSystemPrompt(messages: OpenAIChatMessage[]): string | null;
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * System messages are extracted separately (passed via --system-prompt flag).
 * XML tool patterns in assistant messages are cleaned by cleanAssistantContent()
 * to prevent the model from mimicking XML format instead of using native tools.
 * NO_REPLY assistant messages are filtered out (OpenClaw silent reply tokens).
 */
export declare function messagesToPrompt(messages: OpenAIChatMessage[]): string;
/**
 * The conversation format uses [User] / [Assistant] tags.
 * If Claude doesn't stop cleanly, it may generate a continuation
 * that starts with "\n[User]\n" — bleeding the next human turn's
 * metadata into the assistant response.
 *
 * This strips everything from the first occurrence of "\n[User]"
 * onward, preventing metadata leakage into delivered messages.
 *
 * Also handles "\nHuman:" (legacy format) and
 * "\n[Human]" (alternative format) for robustness.
 */
export declare function stripAssistantBleed(text: string): string;
/**
 * Extract only the latest user message for resumed sessions.
 * When resuming, CLI already has the full conversation history in its session file.
 * Sending the full history would duplicate context and waste tokens.
 */
export declare function extractLatestUserMessage(messages: OpenAIChatMessage[]): string;
/**
 * Convert OpenAI chat request to CLI input format
 *
 * @param request - OpenAI chat request
 * @param hasExistingSession - If true, only extract the latest user message
 *                             (CLI will resume from saved session with full history)
 */
export declare function openaiToCli(request: OpenAIChatRequest, hasExistingSession?: boolean): CliInput;
//# sourceMappingURL=openai-to-cli.d.ts.map