// Unit tests for the per-session guardrails system.
//
// Covers fetchSessionGuardrails (type + session-tag filtering, ordering) and
// reloadGuardrails (the cache used by the outbound-prompt injection). A stub
// HubClient stands in for the memory hub — these run pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSessionGuardrails, saveGuardrail, clearSessionGuardrails, removeGuardrail } from "../sync/guardrails";
import { reloadGuardrails } from "../ui/controllerHubState";
import type { HubStateContext } from "../ui/controllerHubState";

/** Minimal hub stub: records saves and serves them back via searchMemory/getByIds. */
function hubStub(opts: { records?: any[]; configured?: boolean; searchThrows?: boolean } = {}) {
    let store: any[] = opts.records ? [...opts.records] : [];
    return {
        configured: () => opts.configured !== false,
        async searchMemory(_p: { query?: string; type?: string; limit?: number }) {
            if (opts.searchThrows) { throw new Error("hub down"); }
            return store.slice(0, _p.limit ?? store.length);
        },
        async getByIds(ids: string[]) {
            return store.filter((r) => ids.includes(String(r.id)));
        },
        async save(obs: any) {
            if (obs.id) {
                // update-in-place (used by removeGuardrail soft-delete)
                const i = store.findIndex((r) => String(r.id) === String(obs.id));
                if (i >= 0) { store[i] = { ...store[i], ...obs }; return String(store[i].id); }
            }
            const id = "g" + (store.length + 1) + "-" + Date.now();
            store.push({ id, createdAtUtc: new Date().toISOString(), ...obs });
            return id;
        },
    } as any;
}

test("fetchSessionGuardrails: returns only this session's guardrails, oldest first", async () => {
    const sid = "sess-A";
    const hub = hubStub({
        records: [
            { id: "1", type: "guardrail", tags: "guardrail,symposium-session:sess-A", summary: "first", createdAtUtc: "2026-01-03T10:00:00Z" },
            // different session — must be filtered out
            { id: "2", type: "guardrail", tags: "guardrail,symposium-session:sess-B", summary: "other session", createdAtUtc: "2026-01-03T09:00:00Z" },
            // same session but a task — must be filtered out by type
            { id: "3", type: "task-checkpoint", tags: "task-checkpoint,symposium-session:sess-A", summary: "a task", createdAtUtc: "2026-01-03T11:00:00Z" },
            { id: "4", type: "guardrail", tags: "guardrail,symposium-session:sess-A", summary: "second", createdAtUtc: "2026-01-03T12:00:00Z" },
        ],
    });
    const items = await fetchSessionGuardrails(hub, sid);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.text), ["first", "second"], "ordered oldest-first, only this session's guardrails");
});

test("fetchSessionGuardrails: empty when hub not configured or no session", async () => {
    assert.deepEqual(await fetchSessionGuardrails(hubStub({ configured: false }), "sess-A"), []);
    assert.deepEqual(await fetchSessionGuardrails(hubStub(), ""), []);
});

test("saveGuardrail + fetchSessionGuardrails: round-trips with the session tag", async () => {
    const hub = hubStub();
    const sid = "sess-R";
    await saveGuardrail(hub, sid, "  never edit the Razor markup  ");
    const items = await fetchSessionGuardrails(hub, sid);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, "never edit the Razor markup", "text trimmed + stored as summary");
});

test("removeGuardrail: soft-deletes (past expiry) so the item drops from the list", async () => {
    const hub = hubStub();
    const sid = "sess-D";
    const id = await saveGuardrail(hub, sid, "rule to remove");
    let items = await fetchSessionGuardrails(hub, sid);
    assert.equal(items.length, 1);
    const removed = await removeGuardrail(hub, id);
    assert.equal(removed, true);
    items = await fetchSessionGuardrails(hub, sid);
    // Note: the current in-mem stub keeps the record; the real hub filters past
    // expiry. We assert the soft-delete payload was written with a past expiresAtUtc.
    const rec = (hub as any).searchMemory && await hub.getByIds([id]);
    // rec is the updated observation; check it carries a past expiry
    assert.ok(rec[0].expiresAtUtc, "expiry set");
    assert.ok(Date.parse(rec[0].expiresAtUtc) < Date.now(), "expiry is in the past (soft delete)");
});

test("clearSessionGuardrails: removes all of the session's guardrails", async () => {
    const hub = hubStub();
    const sid = "sess-C";
    await saveGuardrail(hub, sid, "one");
    await saveGuardrail(hub, sid, "two");
    const n = await clearSessionGuardrails(hub, sid);
    assert.equal(n, 2, "cleared both");
});

test("reloadGuardrails: fills the cache with texts and marks loaded", async () => {
    const sid = "sess-L";
    const hub = hubStub({
        records: [
            { id: "a", type: "guardrail", tags: "guardrail,symposium-session:sess-L", summary: "alpha", createdAtUtc: "2026-01-03T10:00:00Z" },
            { id: "b", type: "guardrail", tags: "guardrail,symposium-session:sess-L", summary: "beta", createdAtUtc: "2026-01-03T11:00:00Z" },
        ],
    });
    const state: any = { guardrails: [], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(state.guardrails, ["alpha", "beta"]);
    assert.equal(state.guardrailsLoaded, true);
});

test("reloadGuardrails: does NOT mark loaded / wipe cache when the hub throws (so next dispatch retries)", async () => {
    const sid = "sess-X";
    const hub = hubStub({ searchThrows: true });
    const state: any = { guardrails: ["pre-existing"], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(state.guardrails, ["pre-existing"], "prior cache preserved on transient failure");
    assert.equal(state.guardrailsLoaded, false, "flag stays false so the next dispatch retries");
});

test("reloadGuardrails: empty result still marks loaded (not a failure)", async () => {
    const sid = "sess-E";
    const hub = hubStub({ records: [] });
    const state: any = { guardrails: ["stale"], guardrailsLoaded: false, pendingTasks: [] };
    const ctx: HubStateContext = { sessionId: () => sid, hub: () => hub, state };
    await reloadGuardrails(ctx);
    assert.deepEqual(state.guardrails, []);
    assert.equal(state.guardrailsLoaded, true);
});
