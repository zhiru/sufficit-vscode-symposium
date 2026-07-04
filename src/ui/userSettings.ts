import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Writes a single flat-dotted key into the user's settings.json directly.
 *
 * VS Code's Configuration API (`getConfiguration().update`) refuses to write a
 * setting no installed extension has registered — e.g. `gitlens.ai.ollama.url`
 * when GitLens isn't installed (or that key isn't in its schema), which throws
 * "not a registered configuration". Configuring third-party extensions requires
 * editing settings.json as a plain file.
 *
 * Pure JSON (no jsonc-parser dependency — it does not bundle cleanly under
 * esbuild, throwing "Cannot find module './impl/format'"). Comments/trailing
 * commas are tolerated on read; the file is rewritten as clean 2-space JSON.
 *
 * The path is derived from the extension's globalStorageUri
 * (`<...>/User/globalStorage/<ext>` → `<...>/User/settings.json`), correct on
 * desktop and code-server alike.
 */
/**
 * Reads a flat-dotted key straight from settings.json. Needed because
 * getConfiguration().get() returns "" for keys no installed extension
 * registered (gitlens.*, github.copilot.* when those aren't installed), which
 * would render the config fields empty and let a stray change clobber the file.
 */
export function readUserSetting(context: vscode.ExtensionContext, key: string): unknown {
    const userDir = path.resolve(context.globalStorageUri.fsPath, "..", "..");
    const file = path.join(userDir, "settings.json");
    try {
        const raw = fs.readFileSync(file, "utf8");
        const obj = tryParse(raw) ?? tryParse(stripJsonc(raw));
        return obj ? obj[key] : undefined;
    } catch {
        return undefined;
    }
}

export function writeUserSetting(context: vscode.ExtensionContext, key: string, value: unknown): void {
    const userDir = path.resolve(context.globalStorageUri.fsPath, "..", "..");
    const file = path.join(userDir, "settings.json");

    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { /* first write */ }

    let obj: Record<string, unknown> = {};
    if (raw.trim()) {
        obj = tryParse(raw) ?? tryParse(stripJsonc(raw)) ?? {};
    }

    obj[key] = value;   // flat dotted key — settings.json stores keys unnested
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function tryParse(text: string): Record<string, unknown> | undefined {
    try {
        const v = JSON.parse(text);
        return v && typeof v === "object" ? v as Record<string, unknown> : undefined;
    } catch { return undefined; }
}

/** Strips // and /* *\/ comments and trailing commas so JSONC parses as JSON. */
function stripJsonc(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
}
