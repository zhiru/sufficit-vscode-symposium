import { HubClient } from "../sync/hubClient";
import { fetchSessionTasks, TaskItem } from "../sync/tasks";
import { fetchSessionGuardrails } from "../sync/guardrails";

/** Mutable hub-state caches owned by the controller. */
export interface HubState {
    // User-defined guardrails: user rules injected on every outbound.
    guardrails: string[];
    guardrailsLoaded: boolean;
    // Pending-tasks cache: refreshed on every dispatch to catch agent-created tasks.
    pendingTasks: TaskItem[];
}

/**
 * Context bag for the hub-state helpers: per-session guardrails + pending
 * tasks, loaded lazily and refreshed on edit/dispatch. The reminder summary
 * feeds the outbound prompt.
 */
export interface HubStateContext {
    sessionId(): string | undefined;
    hub(): HubClient;
    state: HubState;
}

/**
 * (Re)loads the session's user guardrails into the per-message cache. Called on
 * EVERY dispatch (like tasks) so a guardrail added mid-conversation — by the
 * agent via add_guardrail, or by the user via the UI — is reflected on the next
 * outbound message, and so a transiently-empty first read (eventual indexing on
 * the memory hub) doesn't cache an empty list forever.
 */
export async function reloadGuardrails(ctx: HubStateContext): Promise<void> {
    const id = ctx.sessionId();
    if (!id || !ctx.hub().configured()) { ctx.state.guardrails = []; ctx.state.guardrailsLoaded = true; return; }
    try {
        ctx.state.guardrails = (await fetchSessionGuardrails(ctx.hub(), id)).map((g) => g.text).filter(Boolean);
        ctx.state.guardrailsLoaded = true;
    } catch { /* keep the prior cache; flag stays as-is so the next dispatch retries */ }
}

/** (Re)loads pending tasks and caches the non-done ones. */
export async function reloadTasks(ctx: HubStateContext): Promise<void> {
    const id = ctx.sessionId();
    if (!id || !ctx.hub().configured()) { ctx.state.pendingTasks = []; return; }
    try {
        const all = await fetchSessionTasks(ctx.hub(), id);
        // Only pending tasks (not done)
        ctx.state.pendingTasks = all.filter((t) => !t.done);
    } catch { /* keep the prior cache */ }
}

/** Builds a per-message reminder from pending tasks. */
export function pendingTasksSummary(ctx: HubStateContext): string | undefined {
    if (ctx.state.pendingTasks.length === 0) { return undefined; }
    const items = ctx.state.pendingTasks.map((t) => {
        const userRequested = (t.tags ?? "").includes("user-requested");
        const marker = userRequested ? "[USER]" : "";
        return `- ${marker} ${t.title}`;
    }).join("\n");
    return (
        "[TASKS — You have pending tasks. Call task_complete(id) IMMEDIATELY after finishing each one]\n" +
        items +
        "\n(For user-requested tasks [USER], present justification and WAIT for user confirmation before completing.)"
    );
}
