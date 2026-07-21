import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readCodexMeta } from "../adapters/codex/transcript";

test("Codex metadata restores the most recently used model from turn context", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symposium-codex-meta-"));
    const file = path.join(dir, "rollout.jsonl");
    const rows = [
        { type: "session_meta", payload: { id: "thread-1", cwd: "/workspace" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Investigate model restore" }] } },
        { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));

    const meta = await readCodexMeta(file);
    assert.deepEqual(meta, { id: "thread-1", cwd: "/workspace", title: "Investigate model restore", model: "gpt-5.6-sol" });
    fs.rmSync(dir, { recursive: true, force: true });
});
