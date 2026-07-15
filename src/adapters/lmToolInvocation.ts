import * as vscode from "vscode";

export function lmToolInvocationOptions<T extends object>(
    input: T,
): vscode.LanguageModelToolInvocationOptions<T> {
    return {
        input,
        // An extension can only receive a valid token from a ChatRequest. The
        // native Sufficit flow runs outside that request, so use the documented
        // no-context form. Do not invent an invocationContext: VS Code ignores
        // it and tools such as runInTerminal still reject the call.
        toolInvocationToken: undefined,
    };
}
