import { ChatMessage } from "./types";

export interface ToolHistoryIssue {
    type: "orphan_tool_message" | "missing_tool_result";
    index: number;
    toolCallId?: string;
    toolName?: string;
}

export interface MaterializedToolHistory {
    messages: ChatMessage[];
    foldedOrphanTools: number;
    foldedMissingToolCalls: number;
}

export function findToolHistoryIssues(messages: ChatMessage[]): ToolHistoryIssue[] {
    const issues: ToolHistoryIssue[] = [];
    const seenCalls = new Set<string>();
    const pending = new Map<string, { index: number; name?: string }>();

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === "assistant" && message.tool_calls?.length) {
            for (const toolCall of message.tool_calls) {
                if (!toolCall.id) { continue; }
                seenCalls.add(toolCall.id);
                pending.set(toolCall.id, { index: i, name: toolCall.function.name });
            }
            continue;
        }

        if (message.role === "tool") {
            if (!message.tool_call_id || !seenCalls.has(message.tool_call_id)) {
                issues.push({
                    type: "orphan_tool_message",
                    index: i,
                    toolCallId: message.tool_call_id,
                    toolName: message.name,
                });
                continue;
            }

            pending.delete(message.tool_call_id);
        }
    }

    for (const [toolCallId, call] of pending) {
        issues.push({
            type: "missing_tool_result",
            index: call.index,
            toolCallId,
            toolName: call.name,
        });
    }

    return issues;
}

/**
 * Builds the OpenAI request view from the saved session without mutating the
 * saved transcript. OpenAI-compatible APIs reject role:"tool" messages unless
 * the same request also contains the assistant tool_call that produced them, so
 * legacy/orphaned fragments are folded into neutral system/developer notes.
 */
export function materializeToolSafeHistory(
    messages: ChatMessage[],
    noticeRole: "system" | "developer" = "system",
): MaterializedToolHistory {
    const toolResultIndexes = collectToolResultIndexes(messages);
    const out: ChatMessage[] = [];
    const pending = new Set<string>();
    let foldedOrphanTools = 0;
    let foldedMissingToolCalls = 0;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];

        if (message.role === "assistant" && message.tool_calls?.length) {
            const keptCalls = message.tool_calls.filter((toolCall) => hasToolResultAfter(toolResultIndexes, toolCall.id, i));
            const removedCalls = message.tool_calls.length - keptCalls.length;

            if (removedCalls > 0) {
                foldedMissingToolCalls += removedCalls;
            }

            if (keptCalls.length > 0) {
                for (const toolCall of keptCalls) {
                    pending.add(toolCall.id);
                }
                out.push({
                    ...message,
                    content: removedCalls > 0
                        ? appendToolHistoryNote(message.content, `[${removedCalls} tool request(s) omitted from this live request because their result is outside the materialized context. The saved session is unchanged.]`)
                        : message.content,
                    tool_calls: keptCalls,
                });
                continue;
            }

            if (hasContent(message.content)) {
                out.push({
                    ...message,
                    content: appendToolHistoryNote(message.content, `[${removedCalls} tool request(s) omitted from this live request because their result is outside the materialized context. The saved session is unchanged.]`),
                    tool_calls: undefined,
                });
            } else {
                out.push(toolHistoryNotice(
                    noticeRole,
                    `${removedCalls} assistant tool request(s) were omitted from this live request because their result is outside the materialized context. The saved session is unchanged.`,
                ));
            }
            continue;
        }

        if (message.role === "tool") {
            const id = message.tool_call_id;
            if (id && pending.has(id)) {
                pending.delete(id);
                out.push(message);
                continue;
            }

            foldedOrphanTools++;
            out.push(toolHistoryNotice(
                noticeRole,
                `Tool result "${message.name ?? "unknown"}"${id ? ` (${id})` : ""} was omitted from this live request because its assistant tool_call is not present in the materialized context. The saved session is unchanged.`,
            ));
            continue;
        }

        out.push(message);
    }

    return { messages: out, foldedOrphanTools, foldedMissingToolCalls };
}

export function expandStartToToolBoundary(messages: ChatMessage[], startIndex: number): number {
    let start = Math.max(0, Math.min(startIndex, messages.length));

    while (start < messages.length && messages[start].role === "tool") {
        const toolCallId = messages[start].tool_call_id;
        if (!toolCallId) { break; }

        const assistantIndex = findPrecedingAssistantToolCall(messages, start, toolCallId);
        if (assistantIndex < 0 || assistantIndex === start) { break; }

        start = assistantIndex;
    }

    return start;
}

function collectToolResultIndexes(messages: ChatMessage[]): Map<string, number[]> {
    const indexes = new Map<string, number[]>();

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role !== "tool" || !message.tool_call_id) { continue; }
        const existing = indexes.get(message.tool_call_id) ?? [];
        existing.push(i);
        indexes.set(message.tool_call_id, existing);
    }

    return indexes;
}

function hasToolResultAfter(indexes: Map<string, number[]>, toolCallId: string, messageIndex: number): boolean {
    return (indexes.get(toolCallId) ?? []).some((index) => index > messageIndex);
}

function hasContent(content: ChatMessage["content"]): boolean {
    if (typeof content === "string") { return content.trim().length > 0; }
    return Array.isArray(content) && content.length > 0;
}

function appendToolHistoryNote(content: ChatMessage["content"], note: string): ChatMessage["content"] {
    if (typeof content === "string" && content.trim().length > 0) {
        return `${content}\n\n${note}`;
    }
    // Assistant messages in this adapter use string/null content. If an old
    // session somehow carries structured assistant content, replace only the
    // outbound copy with a neutral note rather than risking an invalid mixed
    // payload for OpenAI-compatible gateways.
    return note;
}

function toolHistoryNotice(role: "system" | "developer", detail: string): ChatMessage {
    return {
        role,
        content: `[Tool history compacted for dispatch: ${detail} Use read_session to recover full details.]`,
    };
}

function findPrecedingAssistantToolCall(messages: ChatMessage[], beforeIndex: number, toolCallId: string): number {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant" && message.tool_calls?.some((toolCall) => toolCall.id === toolCallId)) {
            return i;
        }
    }

    return -1;
}
