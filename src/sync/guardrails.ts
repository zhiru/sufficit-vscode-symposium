import { HubClient } from "./hubClient";
import { sessionTag } from "./tasks";

/**
 * Guardrails are "absolute rules" for a Symposium chat session, stored as
 * Sufficit-memory observations (type "guardrail") bound to the session via the
 * same symposium-session:<id> tag as tasks, and injected into EVERY outbound
 * message so the agent cannot drift from or ignore them.
 *
 * Ownership: the AGENT adds them (via the `add_guardrail` tool) to lock in a
 * hard constraint the user gave it or a commitment it makes. The USER reviews
 * and can remove or clear them from the UI, but never adds — so the panel only
 * appears once the agent has set at least one rule.
 */

export const GUARDRAIL_TYPE = "guardrail";

export interface GuardrailItem {
    id: string;
    text: string;
    ts?: string;
}

const hasTag = (tags: unknown, tag: string): boolean =>
    String(tags ?? "").split(",").map((t) => t.trim()).includes(tag);

/** Lists a session's guardrails, oldest first (definition order). */
export async function fetchSessionGuardrails(hub: HubClient, sessionId: string): Promise<GuardrailItem[]> {
    if (!hub.configured() || !sessionId) { return []; }
    const tag = sessionTag(sessionId);
    const recs = await hub.searchMemory({ type: GUARDRAIL_TYPE, limit: 100 });
    return (recs as any[])
        .filter((r) => hasTag(r.tags, tag))
        .sort((a, b) => Date.parse(a.createdAtUtc || 0) - Date.parse(b.createdAtUtc || 0))
        .map((r) => ({ id: String(r.id), text: r.summary || r.title || "", ts: r.createdAtUtc }));
}

/** Adds a guardrail for the session. Returns the new id. */
export async function saveGuardrail(hub: HubClient, sessionId: string, text: string): Promise<string> {
    const t = text.trim();
    return hub.save({
        type: GUARDRAIL_TYPE,
        title: t.slice(0, 60),
        summary: t,
        tags: `${GUARDRAIL_TYPE},${sessionTag(sessionId)}`,
    });
}

/** Removes one guardrail (soft-delete via past expiry, mirroring tasks). */
export async function removeGuardrail(hub: HubClient, id: string): Promise<boolean> {
    if (!hub.configured() || !id) { return false; }
    const [obs] = await hub.getByIds([id]);
    if (!obs) { return false; }
    await hub.save({ ...obs, expiresAtUtc: new Date(Date.now() - 1000).toISOString() });
    return true;
}

/** Clears all guardrails for a session. Returns how many were removed. */
export async function clearSessionGuardrails(hub: HubClient, sessionId: string): Promise<number> {
    const items = await fetchSessionGuardrails(hub, sessionId);
    let n = 0;
    for (const g of items) {
        try { if (await removeGuardrail(hub, g.id)) { n++; } } catch { /* best-effort */ }
    }
    return n;
}
