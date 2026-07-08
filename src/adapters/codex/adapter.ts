import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtinCommands } from "../builtins";
import { resolveExecutable } from "../exec";
import { scrubJsonlLines, scrubSqliteRows } from "../scrub";
import { findNamedDirs, loadSlashCommands, mergeCommands } from "../skills";
import {
    AgentAdapter,
    AgentSession,
    HistoryMessage,
    SessionInfo,
    SessionStartOptions,
    SlashCommand,
} from "../types";
import { getCached, setCached, ModelCacheEntry } from "../modelCache";
import { CodexAdapterConfig, CodexSession } from "./session";
import { looksInjected, readCodexMeta } from "./transcript";

export function parseCodexModelCatalog(json: unknown, configured = ""): { models: string[]; labels: Record<string, string> } {
    const root = typeof json === "object" && json !== null ? json as Record<string, unknown> : {};
    const raw = Array.isArray(root.models) ? root.models : (Array.isArray(json) ? json : []);
    const entries: Array<{ id: string; priority: number; index: number }> = [];
    const labels: Record<string, string> = {};
    raw.forEach((item, index) => {
        if (typeof item !== "object" || item === null) { return; }
        const model = item as Record<string, unknown>;
        const id = typeof model.slug === "string"
            ? model.slug
            : (typeof model.id === "string" ? model.id : "");
        if (!id || model.visibility === "hide") { return; }
        const priority = typeof model.priority === "number" ? model.priority : Number.POSITIVE_INFINITY;
        entries.push({ id, priority, index });
        const label = typeof model.display_name === "string"
            ? model.display_name
            : (typeof model.name === "string" ? model.name : "");
        if (label && label !== id) { labels[id] = label; }
    });
    entries.sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
    const discovered = entries.map((entry) => entry.id);
    return {
        models: [...new Set([...(configured ? [configured] : []), ...discovered])],
        labels,
    };
}

function runCodexDebugModels(executable: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const child = spawn(resolveExecutable(executable), ["debug", "models"], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`codex debug models exited with code ${code}: ${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export class CodexAdapter implements AgentAdapter {
    readonly backend = "codex" as const;

    constructor(private readonly getConfig: () => CodexAdapterConfig) { }

    async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
        return new Promise((resolve) => {
            const child = spawn(resolveExecutable(this.getConfig().executable), ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (chunk) => { out += String(chunk); });
            child.on("error", (error) => resolve({ ok: false, error: error.message }));
            child.on("exit", (code) =>
                code === 0
                    ? resolve({ ok: true, version: out.trim().split("\n")[0] })
                    : resolve({ ok: false, error: `exit code ${code}` }));
        });
    }

    /** Walks ~/.codex/sessions/YYYY/MM/DD for rollout-*.jsonl files. */
    async listSessions(): Promise<SessionInfo[]> {
        const root = path.join(os.homedir(), ".codex", "sessions");
        const files: string[] = [];
        const walk = async (dir: string, depth: number): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory() && depth < 3) {
                    await walk(full, depth + 1);
                } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
                    files.push(full);
                }
            }
        };
        await walk(root, 0);

        const sessions: SessionInfo[] = [];
        for (const file of files) {
            try {
                const meta = await readCodexMeta(file);
                if (!meta.id) {
                    continue;
                }
                const stat = await fs.promises.stat(file);
                sessions.push({
                    backend: "codex",
                    sessionId: meta.id,
                    title: meta.title ?? path.basename(file),
                    cwd: meta.cwd,
                    updatedAt: stat.mtime,
                    transcriptPath: file,
                });
            } catch {
                // skip unreadable rollout files
            }
        }
        sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
        return sessions.slice(0, 50);
    }

    async history(info: SessionInfo): Promise<HistoryMessage[]> {
        const file = info.transcriptPath;
        if (!file) {
            return [];
        }
        let content: string;
        try {
            content = await fs.promises.readFile(file, "utf8");
        } catch {
            return [];
        }
        const messages: HistoryMessage[] = [];
        for (const line of content.split("\n")) {
            if (!line.trim()) {
                continue;
            }
            interface CodexEntry {
                type: string;
                payload?: {
                    type: string;
                    role?: string;
                    content?: Array<{
                        type: string;
                        text?: string;
                    }>;
                };
            }
            let entry: CodexEntry;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry.type !== "response_item" || entry.payload?.type !== "message") {
                continue;
            }
            const role = entry.payload.role;
            if (role !== "user" && role !== "assistant") {
                continue; // skip developer/system scaffolding
            }
            const text = (entry.payload.content ?? [])
                .filter((c: { type: string }) => c.type === "input_text" || c.type === "output_text" || c.type === "text")
                .map((c: { text?: string }) => c.text)
                .join("")
                .trim();
            // Skip the large injected scaffolding messages (instructions, skills, etc.).
            if (text && !looksInjected(text)) {
                messages.push({ role: role === "user" ? "user" : "assistant", text });
            }
        }
        return messages;
    }

    start(options: SessionStartOptions): AgentSession {
        return new CodexSession(this.getConfig(), options);
    }

    models(): string[] {
        const cfg = this.getConfig();
        const cached = getCached("codex");
        const base = cached?.models ?? [];
        const configured = cfg.model;
        return [...new Set([...(configured ? [configured] : []), ...base])];
    }

    async refreshModels(): Promise<{ models: string[]; labels?: Record<string, string> }> {
        const cfg = this.getConfig();
        const cached = getCached("codex");
        try {
            const json = await runCodexDebugModels(cfg.executable);
            const { models, labels } = parseCodexModelCatalog(json, cfg.model);
            if (models.length) {
                const entry: ModelCacheEntry = { models, labels, lastUpdate: new Date().toISOString() };
                setCached("codex", entry);
                return { models, labels };
            }
        } catch {
            // fall through to cache/fallback
        }
        return { models: this.models(), labels: cached?.labels };
    }

    hasNativeTodo(): boolean { return true; }   // update_plan / todo_list

    // codex -c model_reasoning_effort="<level>" (0.139.0). "default" = omit.
    reasoningLevels(): string[] {
        return ["default", "minimal", "low", "medium", "high"];
    }

    permissionModes(): string[] {
        return ["untrusted", "on-failure", "on-request", "never"];
    }

    defaultPermission(): string {
        const configured = this.getConfig().approvalPolicy;
        return configured && configured !== "default" ? configured : "never";
    }

    async commands(): Promise<SlashCommand[]> {
        const root = path.join(os.homedir(), ".codex");
        const pluginSkills = await findNamedDirs(path.join(root, "plugins"), "skills");
        const discovered = await Promise.all([
            loadSlashCommands(path.join(root, "skills")),
            loadSlashCommands(path.join(root, "prompts")),
            ...pluginSkills.map((r) => loadSlashCommands(r)),
        ]);
        const version = (await this.available()).version;
        return mergeCommands(builtinCommands("codex", version), ...discovered);
    }

    /**
     * Permanently scrubs every on-disk trace of a session from Codex:
     *   - sessions/.../rollout-*-<id>.jsonl  (transcript)
     *   - session_index.jsonl                (line with "id":"<id>")
     *   - history.jsonl                       (entries for the session)
     * Returns the names of stores that may still hold residual data so the
     * caller can warn the user (e.g. the aggregate logs_*.sqlite).
     */
    async deleteSession(info: SessionInfo): Promise<string[]> {
        const root = path.join(os.homedir(), ".codex");
        const id = info.sessionId;
        if (info.transcriptPath) {
            await fs.promises.rm(info.transcriptPath, { force: true });
        }
        await scrubJsonlLines(path.join(root, "session_index.jsonl"),
            (entry) => entry?.id === id || entry?.session_id === id || entry?.thread_id === id);
        await scrubJsonlLines(path.join(root, "history.jsonl"),
            (entry) => entry?.session_id === id || entry?.id === id);

        // Codex also writes an aggregate sqlite log keyed by thread_id (= the
        // session GUID). Delete those rows and VACUUM so nothing lingers in
        // free pages; only report residual if no sqlite tool was available.
        const residual: string[] = [];
        let dbFiles: string[] = [];
        try {
            dbFiles = (await fs.promises.readdir(root)).filter((f) => /^logs.*\.sqlite$/.test(f));
        } catch {
            // ignore
        }
        for (const dbFile of dbFiles) {
            const scrubbed = await scrubSqliteRows(path.join(root, dbFile), "logs", "thread_id", id);
            if (!scrubbed) {
                residual.push(`~/.codex/${dbFile} (install python3 or sqlite3 to scrub)`);
            }
        }
        return residual;
    }
}
