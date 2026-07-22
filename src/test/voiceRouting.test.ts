import { test } from "node:test";
import assert from "node:assert/strict";
import { canUseLocalStt, usesVscodeSpeechBridge } from "../voice/sttRouting";

test("stt routing: auto uses browser speech on web ui", () => {
    assert.strictEqual(canUseLocalStt("auto", true), false);
});

test("stt routing: auto uses local stt on desktop ui", () => {
    assert.strictEqual(canUseLocalStt("auto", false), true);
});

test("stt routing: webspeech never uses local stt", () => {
    assert.strictEqual(canUseLocalStt("webspeech", true), false);
    assert.strictEqual(canUseLocalStt("webspeech", false), false);
});

test("stt routing: explicit local engines keep local stt enabled", () => {
    assert.strictEqual(canUseLocalStt("vscode-speech", false), true);
    assert.strictEqual(canUseLocalStt("whisper-cpp", true), true);
    assert.strictEqual(canUseLocalStt("faster-whisper", true), true);
    assert.strictEqual(canUseLocalStt("vosk", false), true);
});

test("stt routing: only the VS Code provider selects the dictation bridge", () => {
    assert.strictEqual(usesVscodeSpeechBridge("vscode-speech"), true);
    assert.strictEqual(usesVscodeSpeechBridge("auto"), false);
    assert.strictEqual(usesVscodeSpeechBridge("whisper-cpp"), false);
});
