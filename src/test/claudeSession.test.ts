import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSession } from "../adapters/claude/session";
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
