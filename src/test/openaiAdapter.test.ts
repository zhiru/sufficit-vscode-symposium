import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIModelList } from "../adapters/openaiModels";

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
