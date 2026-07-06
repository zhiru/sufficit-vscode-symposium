import { ChatMessage } from "./types";

export interface ToolHistoryIssue {
    type: "orphan_tool_message" | "missing_tool_result";
    index: number;
    toolCallId?: string;
    toolName?: string;
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

function findPrecedingAssistantToolCall(messages: ChatMessage[], beforeIndex: number, toolCallId: string): number {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant" && message.tool_calls?.some((toolCall) => toolCall.id === toolCallId)) {
            return i;
        }
    }

    return -1;
}
