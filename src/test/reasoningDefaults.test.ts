import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REASONING_EFFORT } from "../adapters/reasoning";

test("each built-in adapter declares the effort behind its default picker option", () => {
    assert.deepEqual(DEFAULT_REASONING_EFFORT, {
        claude: "medium",
        codex: "medium",
        copilot: "medium",
        openai: "medium",
    });
});
