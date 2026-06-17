export interface OutboundPromptState {
    policyInjected: boolean;
    todoInjected: boolean;
    seedInjected: boolean;
    autonomyInjected: boolean;
}

export interface BuildOutboundPromptOptions extends OutboundPromptState {
    text: string;
    fileAttachments: string[];
    todoInjection?: string;
    seedHistory?: string;
    autonomy?: string;
}

export const CANCELED_RETRY_PREAMBLE =
    "[Operational rule] If any tool, command or step returns a status/error containing \"canceled\" or \"cancelled\", do not immediately retry. " +
    "First inspect the tool's own message/output and classify whether it was a manual user cancellation, a timeout, a deterministic error, or a transient issue. " +
    "If it looks like a manual cancellation, stop and acknowledge it. Retry only when the tool message gives a concrete reason that rerunning may succeed, and explain that reason before rerunning. Never rerun solely because the status says canceled.";

// Injected once when the user marks themselves "away": full autonomy, no prompts.
export const AUTONOMY_PREAMBLE =
    "[Autonomy mode] The user is not present to answer questions or make decisions and has given you full autonomy. " +
    "Do not wait for input or use interactive prompts (e.g. AskUserQuestion); make reasonable assumptions, decide, " +
    "and carry the task through end-to-end. Briefly state any assumptions and keep going.";

/** Composes the outbound prompt with one-shot policy/context preambles. */
export function buildOutboundPrompt(options: BuildOutboundPromptOptions): { text: string; state: OutboundPromptState } {
    let fullText = options.text;
    if (options.fileAttachments.length) {
        fullText += "\n\nAttached files (read them from disk):\n" +
            options.fileAttachments.map((p) => `- ${p}`).join("\n");
    }

    const prefixes: string[] = [];
    const state: OutboundPromptState = {
        policyInjected: options.policyInjected,
        todoInjected: options.todoInjected,
        seedInjected: options.seedInjected,
        autonomyInjected: options.autonomyInjected,
    };

    if (!state.policyInjected) {
        prefixes.push(CANCELED_RETRY_PREAMBLE);
        state.policyInjected = true;
    }
    if (options.autonomy === "away" && !state.autonomyInjected) {
        prefixes.push(AUTONOMY_PREAMBLE);
        state.autonomyInjected = true;
    }
    if (options.autonomy !== "away") {
        state.autonomyInjected = false;
    }
    if (!state.todoInjected && options.todoInjection) {
        prefixes.push(options.todoInjection);
        state.todoInjected = true;
    }
    if (!state.seedInjected && options.seedHistory) {
        prefixes.push(options.seedHistory);
        state.seedInjected = true;
    }

    if (prefixes.length) {
        fullText = [...prefixes, fullText].join("\n\n---\n\n");
    }
    return { text: fullText, state };
}
