import * as fs from "fs";

/**
 * Codex sessions begin with injected scaffolding (AGENTS.md, IDE context,
 * environment tags) before the real prompt. These are wrapped in tags or
 * markdown headers, so skip `<...>` blocks and `# `-headed context for
 * titles and history.
 */
export function looksInjected(text: string): boolean {
    const value = text.trimStart();
    // The host forwards operational directives as separate user messages in a
    // Codex rollout. They are not a conversation task. Treating the first one
    // as a title made unrelated parent/subagent sessions all look like
    // "[Terminal execution] …", which in turn looked like duplicated work.
    return value.startsWith("<")
        || value.startsWith("# ")
        || /^\[(?:terminal execution|role|operational rule|plan|session|rtk command policy)\b/i.test(value);
}

/** Reads the session_meta line (id, cwd) and first real user prompt (title). */
export async function readCodexMeta(file: string): Promise<{ id?: string; cwd?: string; title?: string; model?: string }> {
    let content: string;
    try {
        content = await fs.promises.readFile(file, "utf8");
    } catch {
        return {};
    }
    let id: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    let model: string | undefined;
    for (const [index, line] of content.split("\n").entries()) {
        if (!line.trim()) {
            continue;
        }
        interface CodexEntry {
            type: string;
            payload?: {
                type?: string;
                id?: string;
                cwd?: string;
                role?: string;
                content?: Array<{ type: string; text?: string }>;
                model?: string;
            };
        }
        let entry: CodexEntry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (entry.type === "session_meta") {
            id = entry.payload?.id;
            cwd = entry.payload?.cwd;
        } else if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
            model = entry.payload.model;
        } else if (!title && index < 60 && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user") {
            const text = (entry.payload.content ?? [])
                .filter((c: { type: string }) => c.type === "input_text" || c.type === "text")
                .map((c: { text?: string }) => c.text)
                .join("")
                .trim();
            if (text && !looksInjected(text)) {
                title = text.slice(0, 80);
            }
        }
    }
    return { id, cwd, title, model };
}
