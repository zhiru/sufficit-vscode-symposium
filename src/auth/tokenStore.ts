import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * File-based fallback store for the Sufficit login tokens.
 *
 * The keyring-less fallback originally used context.globalState, but that is
 * backed by the shared state.vscdb which does NOT reliably persist on some
 * code-server setups (observed 0-byte / not flushed across window reloads), so
 * the login was lost on every reload. The per-extension globalStorage directory
 * IS file-backed and survives reloads, so the token payload is written there
 * instead. Same JSON shape as the SecretStorage payload.
 */
function fallbackFile(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, "identity-fallback.json");
}

export function readFallbackToken(context: vscode.ExtensionContext): string | undefined {
    try {
        const raw = fs.readFileSync(fallbackFile(context), "utf8");
        return raw ? raw : undefined;
    } catch {
        return undefined;
    }
}

export function writeFallbackToken(context: vscode.ExtensionContext, payload: string | undefined): void {
    const file = fallbackFile(context);
    try {
        if (payload === undefined) {
            fs.rmSync(file, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, payload, "utf8");
    } catch {
        /* best-effort — never block login on a fallback write failure */
    }
}
