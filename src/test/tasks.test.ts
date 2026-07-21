import { test } from "node:test";
import assert from "node:assert/strict";
import { HubClient } from "../sync/hubClient";
import { fetchSessionTasks, rememberTaskCreated, rememberTaskDone } from "../sync/tasks";

test("pending tasks do not expire locally while the hub index is stale", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
        const sessionId = "task-cache-long-plan";
        rememberTaskCreated(sessionId, "task-a", "First long-running step");
        rememberTaskCreated(sessionId, "task-b", "Second long-running step");
        now += 24 * 60 * 60 * 1_000;

        const hub = {
            configured: () => true,
            searchMemory: () => Promise.resolve([]),
        } as unknown as HubClient;
        rememberTaskDone(sessionId, "task-a");
        const pending = await fetchSessionTasks(hub, sessionId);

        assert.deepEqual(pending.map((task) => task.id), ["task-b"]);
    } finally {
        Date.now = originalNow;
    }
});

test("indexed tasks replace the local anti-lag copy", async () => {
    const sessionId = "task-cache-indexed";
    rememberTaskCreated(sessionId, "task-indexed", "Indexed step");
    const hub = {
        configured: () => true,
        searchMemory: () => Promise.resolve([{
            id: "task-indexed", type: "task-anchor", sessionId,
            title: "Indexed step", summary: "Indexed step", tags: "task-anchor",
            createdAtUtc: "2026-07-21T00:00:00Z",
        }]),
    } as unknown as HubClient;

    const tasks = await fetchSessionTasks(hub, sessionId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "task-indexed");
});
