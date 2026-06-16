import { TodoItem } from "./types";
import { parseNativeTodos } from "./todos";

/**
 * Pure parsing/formatting helpers shared by the Claude adapter (and tests).
 * Deliberately free of vscode/fs imports so they can be unit-tested under
 * plain Node.
 */

/**
 * A short, human target for a tool call — the file, command, pattern or url —
 * so the UI can show "Read foo.ts" / "Ran npm test" instead of a raw JSON blob.
 */
export function summarizeToolInput(input: unknown): string {
    const o = (input ?? {}) as Record<string, unknown>;
    const short = (p: unknown) => {
        const parts = String(p).split("/").filter(Boolean);
        return parts.slice(-2).join("/") || String(p);
    };
    const filePath = typeof o.file_path === "string" ? o.file_path
        : typeof o.notebook_path === "string" ? o.notebook_path
            : typeof o.path === "string" ? o.path : undefined;
    let s = "";
    // A human-readable description (e.g. Bash tool's `description`) is the intent
    // the user cares about — prefer it over the raw command/args.
    if (typeof o.description === "string" && o.description.trim()) { s = o.description.trim(); }
    else if (filePath) {
        s = short(filePath);
        if (typeof o.offset === "number") {
            const end = typeof o.limit === "number" ? o.offset + o.limit : undefined;
            s += ":" + o.offset + (end ? "-" + end : "");
        }
    }
    else if (typeof o.command === "string") { s = o.command.trim().replace(/\s+/g, " "); }
    else if (typeof o.pattern === "string") { s = '"' + o.pattern + '"' + (typeof o.path === "string" ? " in " + short(o.path) : ""); }
    else if (typeof o.url === "string") { s = o.url; }
    else if (typeof o.query === "string") { s = o.query; }
    else if (typeof o.description === "string") { s = o.description; }
    else if (typeof o.prompt === "string") { s = o.prompt; }
    else {
        const first = Object.values(o).find((v) => typeof v === "string") as string | undefined;
        s = first ?? "";
    }
    return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

/** Context window (tokens) for a Claude model; default 200k. */
export function contextWindowFor(model: string): number {
    const m = (model || "").toLowerCase();
    if (m.includes("[1m]") || m.includes("-1m")) { return 1000000; }
    return 200000;
}

/** Absolute file a tool acts on (Read/Edit/Write/NotebookEdit), if any. */
export function toolFilePath(input: unknown): string | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    const p = o.file_path ?? o.notebook_path;
    return typeof p === "string" && p ? p : undefined;
}

/** Line count of a string block (0 for empty/missing). */
export function lineCount(s: unknown): number {
    return typeof s === "string" && s.length ? s.split("\n").length : 0;
}

/**
 * Approximate added/removed line counts for a write/edit tool. Edit: new vs old
 * string; MultiEdit: summed; Write: whole content added.
 */
export function diffCounts(name: string, input: unknown): { added: number; removed: number } | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    if (name === "Write") {
        return { added: lineCount(o.content), removed: 0 };
    }
    if (name === "Edit") {
        return { added: lineCount(o.new_string), removed: lineCount(o.old_string) };
    }
    if (name === "MultiEdit" && Array.isArray(o.edits)) {
        let added = 0, removed = 0;
        for (const e of o.edits as any[]) { added += lineCount(e?.new_string); removed += lineCount(e?.old_string); }
        return { added, removed };
    }
    return undefined;
}

/** Old/new hunks for an edit tool, for a red/green diff view. */
export function editDiff(name: string, input: unknown): { old: string; new: string }[] | undefined {
    const o = (input ?? {}) as Record<string, unknown>;
    if (name === "Edit" && typeof o.old_string === "string") {
        return [{ old: o.old_string, new: typeof o.new_string === "string" ? o.new_string : "" }];
    }
    if (name === "MultiEdit" && Array.isArray(o.edits)) {
        return (o.edits as any[])
            .map((e) => ({ old: String(e?.old_string ?? ""), new: String(e?.new_string ?? "") }))
            .filter((e) => e.old || e.new);
    }
    if (name === "Write" && typeof o.content === "string") {
        return [{ old: "", new: o.content }];
    }
    return undefined;
}

/** Extract a plan/todo list from a tool call, if it is one. */
export function extractTodos(name: string, input: unknown): TodoItem[] | undefined {
    return parseNativeTodos(name, input);
}

/** Pretty-print a tool input for the expandable panel (capped). */
export function prettyJson(input: unknown): string {
    try {
        const s = JSON.stringify(input, null, 2);
        return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
    } catch {
        return String(input ?? "");
    }
}

/** Flatten a tool_result content (string or content blocks) to text (capped). */
export function toolResultText(content: unknown): string {
    let s: string;
    if (typeof content === "string") {
        s = content;
    } else if (Array.isArray(content)) {
        s = content.map((b: any) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    } else {
        try { s = JSON.stringify(content); } catch { s = String(content ?? ""); }
    }
    return s.length > 6000 ? s.slice(0, 6000) + "\n…(truncated)" : s;
}
