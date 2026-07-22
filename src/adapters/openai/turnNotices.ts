import type { AgentEvent } from "../types";

/**
 * Guardrail stops are runtime decisions made by Symposium, not words produced
 * by the model. Keeping them as structured warning notices prevents the UI and
 * transcript from attributing them to the assistant.
 */
export function guardrailStopNotice(text: string): AgentEvent {
    return { kind: "status-notice", severity: "warning", text };
}

/** Reclassifies guardrail messages persisted by versions that emitted them as assistant text. */
export function legacyGuardrailStopNotice(text: string): AgentEvent | null {
    const value = String(text ?? "").trim();
    if (!/^_\(stopped(?::|\s+after\b).*\)_$/i.test(value)) { return null; }
    let message = value.slice(2, -2).trim();
    message = message.charAt(0).toUpperCase() + message.slice(1);
    message = message.replace(/\b(\d+)x\b/g, "$1 times");
    if (!/[.!?]$/.test(message)) { message += "."; }
    return guardrailStopNotice(message);
}
