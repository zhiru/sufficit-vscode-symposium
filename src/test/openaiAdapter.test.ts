import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIModelList } from "../adapters/openaiModels";
import { sanitizeToolParametersForOpenAI } from "../adapters/openaiSchema";
import { compressMessages } from "../compression/webhook";
import { findToolHistoryIssues } from "../adapters/openai/toolHistory";
import { ChatMessage } from "../adapters/openai/types";
import { mergeToolDefinitions } from "../adapters/openai/toolMerge";

test("buildOpenAIModelList does not invent OpenAI fallback models", () => {
    assert.deepEqual(buildOpenAIModelList([], ""), []);
    assert.deepEqual(buildOpenAIModelList([], "sufficit-dev"), ["sufficit-dev"]);
});

test("buildOpenAIModelList keeps configured model and configured list", () => {
    assert.deepEqual(
        buildOpenAIModelList(["sufficit-dev", "sufficit-fast"], "sufficit-dev"),
        ["sufficit-dev", "sufficit-fast"],
    );
});

test("sanitizeToolParametersForOpenAI removes unsupported nested schema keys", () => {
    assert.deepEqual(
        sanitizeToolParametersForOpenAI({
            type: "object",
            propertyNames: { pattern: "^[a-z]+$" },
            properties: {
                data: {
                    type: "object",
                    propertyNames: { type: "string" },
                    patternProperties: { "^x-": { type: "string" } },
                    properties: {
                        value: { type: "string" },
                    },
                },
            },
        }),
        {
            type: "object",
            properties: {
                data: {
                    type: "object",
                    properties: {
                        value: { type: "string" },
                    },
                },
            },
        },
    );
});

test("compressMessages preserves tool-call boundary when keeping recent history", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "older user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_old", type: "function", function: { name: "shell", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_old", name: "shell", content: "old result" },
        { role: "user", content: "new user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_new", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
        },
        { role: "tool", tool_call_id: "call_new", name: "read_file", content: "new result" },
        { role: "assistant", content: "done" },
    ];

    const compressed = compressMessages(messages, "summarize", { keepRecent: 5 });

    assert.deepEqual(
        compressed.map((m) => m.role === "tool" ? `tool:${m.tool_call_id}` : m.role),
        ["system", "assistant", "tool:call_old", "user", "assistant", "tool:call_new", "assistant"],
    );
    assert.deepEqual(findToolHistoryIssues(compressed), []);
});

test("findToolHistoryIssues reports invalid dispatch windows without repairing them", () => {
    const messages: ChatMessage[] = [
        { role: "system", content: "system" },
        { role: "tool", tool_call_id: "call_old", name: "shell", content: "old result" },
        { role: "user", content: "new user" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "call_new", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
        },
    ];

    assert.deepEqual(
        findToolHistoryIssues(messages).map((issue) => issue.type),
        ["orphan_tool_message", "missing_tool_result"],
    );
});

test("mergeToolDefinitions prefixes collisions without mutating shared tool defs", () => {
    const symTool = {
        type: "function",
        function: {
            name: "search",
            description: "Search memory",
        },
    };
    const localTool = {
        type: "function",
        function: {
            name: "search",
            description: "Search files",
        },
    };

    const merged = mergeToolDefinitions([
        { tool: symTool, source: "sym_" },
        { tool: localTool, source: "local_" },
    ]);

    assert.deepEqual(
        merged.map((tool) => tool.function?.name),
        ["sym_search", "local_search"],
    );
    assert.equal(symTool.function.name, "search");
    assert.equal(symTool.function.description, "Search memory");
    assert.equal(localTool.function.name, "search");
    assert.equal(localTool.function.description, "Search files");
    assert.notEqual(merged[0], symTool);
    assert.notEqual(merged[0].function, symTool.function);
});
