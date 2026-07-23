import { test } from "node:test";
import assert from "node:assert/strict";
import { presentTurnError } from "../ui/errorPresentation";

test("all-backends-exhausted 503 has a concise actionable system summary", () => {
    const raw = 'HTTP 503 Service Unavailable {"error":{"message":"responses failed: All AI backends exhausted","code":"ai_backends_exhausted"}}';
    const out = presentTurnError(raw, true);

    assert.match(out.summary, /HTTP 503/);
    assert.match(out.summary, /all configured backends were unavailable/i);
    assert.match(out.summary, /not retry automatically/i);
    assert.equal(out.detail, raw);
});

test("403 stays non-retryable in the inline explanation", () => {
    const out = presentTurnError("HTTP 403 Forbidden", false);

    assert.match(out.summary, /HTTP 403/);
    assert.match(out.summary, /Retry is unavailable/i);
});

test("unknown terminal errors preserve their technical detail", () => {
    const out = presentTurnError("socket closed unexpectedly", true);

    assert.match(out.summary, /ended before the agent could reply/i);
    assert.equal(out.detail, "socket closed unexpectedly");
});
