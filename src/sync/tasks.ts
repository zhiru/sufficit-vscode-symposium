import { HubClient, Observation } from "./hubClient";

/**
 * Symposium tasks are Sufficit-memory observations (task-anchor / task-checkpoint)
 * bound to a specific Symposium chat session via a tag. The session id is the
 * link: listing a session's tasks and removing them on session delete both key
 * off this marker.
 *
 * Deletion uses expiry (the hub mirrors the MCP, which has no hard delete): we
 * re-save each observation with an expiresAtUtc in the past so it drops out.
 */

export const SESSION_TAG_PREFIX = "symposium-session:";
export const sessionTag = (sessionId: string): string => SESSION_TAG_PREFIX + sessionId;
/** Tag marking a task observation as completed (pending = absent). */
export const DONE_TAG = "status:done";

export interface TaskItem {
    id: string;
    type: string;
    title: string;
    summary: string;
    ts?: string;
    tags?: string;
    /** True when the task carries the DONE_TAG (completed). */
    done?: boolean;
}

const isTask = (type: unknown): boolean => String(type ?? "").startsWith("task");
const hasTag = (tags: unknown, tag: string): boolean => String(tags ?? "").split(",").map((t) => t.trim()).includes(tag);

/**
 * Short-lived recent-create cache, keyed by session: the hub's search index
 * (which fetchSessionTasks reads from) can lag well behind a save — a task
 * created moments ago may not be visible yet. Without this, task_complete's
 * "remaining" check reads a stale list missing that just-created sibling and
 * wrongly reports allTasksComplete while real work is still pending. Mirrors
 * surfaceSync.ts's ghost-task grace window, but protects the TOOL's own
 * signal to the model rather than just the task panel's display.
 */
const RECENT_CREATE_GRACE_MS = 60_000;
interface RecentTask { id: string; title: string; ts: number; done: boolean; }
const recentBySession = new Map<string, RecentTask[]>();

/** Records a just-created task so it survives a search-index lag window. */
export function rememberTaskCreated(sessionId: string, id: string, title: string): void {
    const list = recentBySession.get(sessionId) ?? [];
    list.push({ id, title, ts: Date.now(), done: false });
    recentBySession.set(sessionId, list);
}

/** Marks a recently-created task done, so it stops padding "remaining". */
export function rememberTaskDone(sessionId: string, id: string): void {
    const entry = recentBySession.get(sessionId)?.find((t) => t.id === id);
    if (entry) { entry.done = true; }
}

/**
 * Sequential-batch tracking for task_complete's cascade: one add_task call
 * with N titles is documented as "in order" (a numbered plan, meant to be
 * done in sequence) — so completing task K implies 1..K-1 in that SAME batch
 * are also done, even if the agent forgot to call task_complete on them
 * individually. A LATER, separate add_task call is its own batch (not
 * assumed to continue the same sequence) — only ids created in one call
 * cascade together.
 */
const batchesBySession = new Map<string, string[][]>();

/** Records one add_task call's ids, in the order given, as a cascade batch. */
export function rememberTaskBatch(sessionId: string, ids: string[]): void {
    if (ids.length < 2) { return; }   // nothing to cascade for a single-task batch
    const list = batchesBySession.get(sessionId) ?? [];
    list.push([...ids]);
    batchesBySession.set(sessionId, list);
}

/** Ids that precede `id` in its batch (if any), earliest first. */
export function priorInBatch(sessionId: string, id: string): string[] {
    const batches = batchesBySession.get(sessionId);
    if (!batches) { return []; }
    for (const batch of batches) {
        const idx = batch.indexOf(id);
        if (idx > 0) { return batch.slice(0, idx); }
        if (idx === 0) { return []; }
    }
    return [];
}

/** Recently-created, still-pending tasks within the grace window (prunes stale entries as a side effect). */
function recentPending(sessionId: string): RecentTask[] {
    const list = recentBySession.get(sessionId);
    if (!list) { return []; }
    const fresh = list.filter((t) => Date.now() - t.ts < RECENT_CREATE_GRACE_MS);
    recentBySession.set(sessionId, fresh);
    return fresh.filter((t) => !t.done);
}

/** Lists the task observations bound to a Symposium session (newest first). */
export async function fetchSessionTasks(hub: HubClient, sessionId: string): Promise<TaskItem[]> {
    if (!hub.configured() || !sessionId) { return []; }
    // Search is scoped to the session by the native sessionId field on the
    // server; keep only task-type records for this session, newest first.
    const recs = await hub.searchMemory({ limit: 100, sessionId });
    const fromSearch = (recs as Array<{ type: string; sessionId?: string; tags?: string | string[]; id: unknown; title?: string; summary?: string; createdAtUtc?: string | number }>)
        .filter((r) => isTask(r.type) && (r.sessionId ?? "") === sessionId)
        .sort((a, b) => Date.parse(String(b.createdAtUtc || "0")) - Date.parse(String(a.createdAtUtc || "0")))
        .slice(0, 30)
        .map((r) => ({ id: String(r.id), type: r.type, title: r.title ?? "", summary: r.summary ?? "", ts: String(r.createdAtUtc || ""), tags: Array.isArray(r.tags) ? r.tags.join(",") : r.tags ?? "", done: hasTag(r.tags, DONE_TAG) }));
    const knownIds = new Set(fromSearch.map((t) => t.id));
    const ghosts = recentPending(sessionId)
        .filter((t) => !knownIds.has(t.id))
        .map((t): TaskItem => ({ id: t.id, type: "task-anchor", title: t.title, summary: t.title, done: false }));
    return [...fromSearch, ...ghosts];
}

/** Sets/clears a task's completed state (DONE_TAG). User- or agent-driven. */
export async function setTaskDone(hub: HubClient, id: string, done: boolean, completionSummary?: string): Promise<boolean> {
    if (!hub.configured() || !id) { return false; }
    // Direct upsert: save is id-based. Append or remove DONE_TAG without
    // spreading stale API fields back into the payload.
    try {
        const [obs] = await hub.getByIds([id]);
        const existing = obs ? String(obs.tags ?? "") : "";
        const tags = existing.split(",").map((t) => t.trim()).filter(Boolean).filter((t) => t !== DONE_TAG);
        if (done) { tags.push(DONE_TAG); }
        const baseSummary = obs?.summary || "";
        const summary = completionSummary?.trim()
            ? (baseSummary ? `${baseSummary}\n\nCompleted: ${completionSummary.trim()}` : `Completed: ${completionSummary.trim()}`)
            : baseSummary;
        await hub.save({ id, type: obs?.type || "task-checkpoint", title: obs?.title || "task", summary, tags: tags.join(",") });
        return true;
    } catch { return false; }
}

/** Marks a task observation completed by adding the DONE_TAG (idempotent). */
export async function markTaskDone(hub: HubClient, id: string, completionSummary?: string): Promise<boolean> {
    // Delegate to setTaskDone which preserves existing tags (including the
    // critical symposium-session:xxx tag). A blind upsert with only DONE_TAG
    // wipes the session tag → fetchSessionTasks filter can never find the task
    // again → panel shows stale "pending" forever.
    return setTaskDone(hub, id, true, completionSummary);
}

/** Latest PENDING task-checkpoint for a session (falls back to latest pending task, then any). */
export async function fetchLatestCheckpoint(hub: HubClient, sessionId: string): Promise<TaskItem | undefined> {
    const tasks = await fetchSessionTasks(hub, sessionId);
    return tasks.find((t) => t.type === "task-checkpoint" && !t.done)
        ?? tasks.find((t) => !t.done)
        ?? tasks[0];
}

/** Expires (soft-deletes) every task observation bound to a session. Returns count. */
export async function expireSessionTasks(hub: HubClient, sessionId: string): Promise<number> {
    recentBySession.delete(sessionId);
    if (!hub.configured() || !sessionId) { return 0; }
    const recs = await hub.searchMemory({ limit: 200, sessionId });
    const ids = (recs as Array<{ type: string; sessionId?: string; id: unknown }>).filter((r) => isTask(r.type) && (r.sessionId ?? "") === sessionId).map((r) => String(r.id)).filter(Boolean);
    if (!ids.length) { return 0; }
    const full = await hub.getByIds(ids);
    const past = new Date(Date.now() - 1000).toISOString();
    let n = 0;
    for (const o of full as Array<Observation>) {
        try { await hub.save({ ...o, expiresAtUtc: past }); n++; } catch { /* best-effort */ }
    }
    return n;
}
