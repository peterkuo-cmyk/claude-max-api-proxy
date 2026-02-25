/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIToolCall } from "../types/openai.js";
export interface ParsedToolCallResult {
    hasToolCalls: boolean;
    toolCalls: OpenAIToolCall[];
    /** Response text with all <tool_call> markers removed */
    textWithoutToolCalls: string;
}
/**
 * Parse <tool_call>...</tool_call> markers out of the full response text.
 *
 * The model emits tool calls in this format when external tools are provided:
 *   <tool_call>{"id":"call_1","name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>
 *
 * Per the OpenAI spec, function.arguments must be a JSON *string*, not an object.
 * If the model produces an object (which is easier for it to output reliably),
 * we normalize it to a JSON string here.
 */
export declare function parseToolCalls(text: string): ParsedToolCallResult;
/**
 * Create synthesized SSE chunks that represent tool calls in OpenAI streaming format.
 *
 * OpenAI streaming tool call protocol:
 *   1. First chunk:  role="assistant", tool_calls=[{index, id, type, function.name, function.arguments=""}]
 *   2. Argument chunks: tool_calls=[{index, function.arguments: "<partial_json>"}]
 *   3. Final chunk:  finish_reason="tool_calls", empty delta
 *
 * Since we buffer the full response before parsing, we emit everything at once
 * (no incremental argument streaming).
 */
export declare function createToolCallChunks(toolCalls: OpenAIToolCall[], requestId: string, model: string): OpenAIChatChunk[];
/**
 * Create a final "done" chunk for streaming (normal text completion)
 */
export declare function createDoneChunk(requestId: string, model: string): OpenAIChatChunk;
/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 * Automatically detects and parses tool calls from the result text.
 */
export declare function cliResultToOpenai(result: ClaudeCliResult, requestId: string): OpenAIChatResponse;
//# sourceMappingURL=cli-to-openai.d.ts.map