/**
 * User-facing description for a terminal backend error. Keep the complete
 * provider payload separate: gateways often return nested JSON that is useful
 * for support but far too noisy to be the only thing a user sees in chat.
 */
export interface ErrorPresentation {
    summary: string;
    detail: string;
}

function httpStatus(message: string): number | undefined {
    const match = /\bHTTP\s+(\d{3})\b/i.exec(message);
    return match ? Number(match[1]) : undefined;
}

/**
 * Classifies an adapter error without exposing provider jargon as the primary
 * UI. This is presentation only: the exact error remains available in the
 * expandable technical-details section and on the Retry hand-off.
 */
export function presentTurnError(message: unknown, retryable?: boolean): ErrorPresentation {
    const detail = String(message ?? "").trim() || "The request ended without an error detail from the backend.";
    const status = httpStatus(detail);
    const retry = retryable === true
        ? " You may retry the same message; Symposium will not retry automatically."
        : " Retry is unavailable for this response; update the request or configuration before sending again.";

    if (status === 503 && /ai_backends_exhausted|all ai backends exhausted/i.test(detail)) {
        return {
            summary: "The AI provider could not complete this request (HTTP 503: all configured backends were unavailable)." + retry,
            detail,
        };
    }
    if (status === 503) {
        return { summary: "The AI provider is temporarily unavailable (HTTP 503)." + retry, detail };
    }
    if (status === 429) {
        return { summary: "The AI provider is rate-limiting requests (HTTP 429)." + retry, detail };
    }
    if (status === 408 || status === 504) {
        return { summary: `The request timed out (HTTP ${status}).` + retry, detail };
    }
    if (status === 401 || status === 403) {
        return { summary: `The request was rejected by the provider (HTTP ${status}).` + retry, detail };
    }
    return { summary: "The request ended before the agent could reply." + retry, detail };
}
