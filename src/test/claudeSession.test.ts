import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSession } from "../adapters/claude/session";
import { claudeResumeSessionId } from "../adapters/claude/resume";
import type { AgentEvent } from "../adapters/types";

function waitForTurnEnd(session: ClaudeSession): Promise<AgentEvent[]> {
    return new Promise((resolve, reject) => {
        const events: AgentEvent[] = [];
        const timer = setTimeout(() => reject(new Error("timed out waiting for Claude turn-end")), 2000);
        const listener = (event: AgentEvent) => {
            events.push(event);
            if (event.kind === "turn-end") {
                clearTimeout(timer);
                session.off("event", listener);
                resolve(events);
            }
        };
        session.on("event", listener);
    });
}

test("Claude retries spawn after ENOENT instead of reusing the dead child", async () => {
    const session = new ClaudeSession({
        executable: "symposium-test-claude-does-not-exist",
        model: "",
        permissionMode: "plan",
        env: {},
    }, { cwd: process.cwd() });

    try {
        const first = waitForTurnEnd(session);
        session.send("first attempt");
        const firstEvents = await first;

        const second = waitForTurnEnd(session);
        session.send("second attempt");
        const secondEvents = await second;

        for (const events of [firstEvents, secondEvents]) {
            assert.ok(events.some((event) => event.kind === "error" && /ENOENT/.test(event.message)));
            assert.equal(events.at(-1)?.kind, "turn-end");
        }
    } finally {
        session.dispose();
    }
});

test("Claude resumes a listed subagent through its parent conversation UUID", () => {
    assert.equal(
        claudeResumeSessionId("33cce505-8848-4f48-88a5-da7faedcd4f2/subagents/agent-a1bb4e66e2be943da"),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
});

test("Claude keeps normal session ids and titles unchanged", () => {
    assert.equal(
        claudeResumeSessionId("33cce505-8848-4f48-88a5-da7faedcd4f2"),
        "33cce505-8848-4f48-88a5-da7faedcd4f2",
    );
    assert.equal(claudeResumeSessionId("my named session"), "my named session");
    assert.equal(claudeResumeSessionId("not-a-uuid/subagents/agent-123"), "not-a-uuid/subagents/agent-123");
});
