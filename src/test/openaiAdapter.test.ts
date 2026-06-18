import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIModelList } from "../adapters/openaiModels";
import { sanitizeToolParametersForOpenAI } from "../adapters/openaiSchema";

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
