import * as vscode from "vscode";

type RuntimeLanguageModelToolInvocationOptions<T extends object> =
    vscode.LanguageModelToolInvocationOptions<T> & {
        invocationContext: {
            requestId: string;
            toolCallId: string;
            sessionId: string;
            source: string;
        };
    };

function invocationId(): string {
    return `symposium-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function lmToolInvocationOptions<T extends object>(
    input: T,
): RuntimeLanguageModelToolInvocationOptions<T> {
    const id = invocationId();
    return {
        input,
        toolInvocationToken: undefined,
        // Newer VS Code/code-server runtimes require an invocation context even
        // though the 1.100 extension typings used by this project do not expose
        // it yet. Without this, built-in tools such as runInTerminal fail before
        // executing with "Invocation context must be provided for this tool".
        invocationContext: {
            requestId: id,
            toolCallId: id,
            sessionId: "symposium",
            source: "sufficit-vscode-symposium",
        },
    };
}
