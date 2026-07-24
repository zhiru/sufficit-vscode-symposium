import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = (file: string): string => readFileSync(resolve(__dirname, "../../src", file), "utf8");

test("VS Code Speech restores the originating Symposium composer after starting", () => {
    const bridge = source("voice/vscodeSpeechBridge.ts");
    const startCommand = bridge.indexOf("executeCommand(START_DICTATION_COMMAND)");
    const restoreFocus = bridge.indexOf("await session.restoreFocus();", startCommand);
    const returnStarted = bridge.indexOf("return true;", restoreFocus);

    assert.ok(startCommand >= 0, "bridge must start native editor dictation");
    assert.match(bridge, /await vscode\.window\.tabGroups\.close\(transcriptTab, true\)/);
    assert.ok(restoreFocus > startCommand, "composer must be restored after the command captures its editor model");
    assert.ok(returnStarted > restoreFocus, "focus restoration must finish before recording is reported as active");
});

test("each chat surface supplies an exact reveal callback to speech dictation", () => {
    const panel = source("ui/chatPanel.ts");
    const view = source("ui/chatView.ts");
    const voice = source("ui/surfaceMessageVoice.ts");

    assert.match(panel, /\(\) => this\.panel\.reveal\(this\.panel\.viewColumn, true\)/);
    assert.match(view, /executeCommand\(`\$\{ChatViewProvider\.viewId\}\.focus`\)/);
    assert.match(voice, /startVscodeSpeechDictation\(settings\.language, d\.restoreFocus\)/);
});

test("VS Code Speech independently exposes and routes the webview microphone", () => {
    const prefs = source("ui/webview/voicePrefs.ts");
    const voice = source("ui/webview/voice.ts");

    assert.match(prefs, /canVscodeSpeech = prefs\.vscodeSpeechBridge/);
    assert.match(prefs, /canWebSpeech \|\| canLocal \|\| canVscodeSpeech/);
    assert.match(prefs, /if \(prefs\.vscodeSpeechBridge\) \{ return "local"; \}/);
    assert.match(voice, /prefs\.hostCapture \|\| prefs\.vscodeSpeechBridge/);
});
