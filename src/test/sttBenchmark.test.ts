import { test } from "node:test";
import assert from "node:assert/strict";
import { SUFFICIT_VOICE_BENCHMARK_PROMPT } from "../voice/sttBenchmark";

test("voice benchmark includes VS Code Speech without fabricating WAV metrics", () => {
    assert.match(SUFFICIT_VOICE_BENCHMARK_PROMPT, /4 candidatos locais/);
    assert.match(SUFFICIT_VOICE_BENCHMARK_PROMPT, /ms-vscode\.vscode-speech/);
    assert.match(SUFFICIT_VOICE_BENCHMARK_PROMPT, /3 engines CLI/);
    assert.match(SUFFICIT_VOICE_BENCHMARK_PROMPT, /NUNCA atribua ao VS Code Speech/);
    assert.match(SUFFICIT_VOICE_BENCHMARK_PROMPT, /candidato interativo pendente/);
});
