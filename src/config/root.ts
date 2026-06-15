import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Local storage root for Symposium's vendor-neutral agent knowledge.
 *
 * Layout (see sufficit-ai/docs/TODO-agent-knowledge-sync.md):
 *   ~/.symposium/
 *     repo/{agents,skills,tools,instructions}/   git-versioned canonical source
 *     index/                                     light index for offline search
 *     projections/<backend>/                     adapter output (ephemeral)
 *     cache/                                     sync state (etags/hashes)
 *     state.json                                 health, last sync, pending pushes
 *
 * The root is the runtime source: Symposium reads agents from these files and
 * works offline. The memory REST API only distributes them between machines.
 */

export type ResourceKind = "agent" | "skill" | "tool" | "instruction";

export interface ResourceEntry {
    kind: ResourceKind;
    name: string;
    description: string;
    /** Absolute path to the resource file (or the SKILL.md for a skill bundle). */
    path: string;
    /** True for multi-file skill bundles. */
    bundle: boolean;
}

export interface SyncState {
    /** Last known health of the sufficit-ai memory hub. */
    health: "ok" | "down" | "unknown";
    /** ISO timestamp of the last successful sync, if any. */
    lastSyncUtc?: string;
    /** Resource names with local edits not yet pushed to the hub. */
    pendingPush: string[];
}

const DEFAULT_STATE: SyncState = { health: "unknown", pendingPush: [] };

/** Maps each resource kind to its subdirectory under repo/. */
const KIND_DIR: Record<ResourceKind, string> = {
    agent: "agents",
    skill: "skills",
    tool: "tools",
    instruction: "instructions",
};

/** Resolves the configured root, defaulting to ~/.symposium. */
export function rootDir(): string {
    const configured = vscode.workspace.getConfiguration("symposium").get<string>("root", "");
    if (configured && configured.trim()) {
        return configured.replace(/^~(?=$|\/)/, os.homedir());
    }
    return path.join(os.homedir(), ".symposium");
}

export function repoDir(): string {
    return path.join(rootDir(), "repo");
}

export function projectionsDir(backend: string): string {
    return path.join(rootDir(), "projections", backend);
}

/** Creates the directory scaffold if missing. Idempotent. */
export function ensureScaffold(): void {
    const root = rootDir();
    const dirs = [
        repoDir(),
        ...Object.values(KIND_DIR).map((d) => path.join(repoDir(), d)),
        path.join(root, "index"),
        path.join(root, "projections"),
        path.join(root, "cache"),
    ];
    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const gitignore = path.join(root, ".gitignore");
    if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, "projections/\ncache/\n", "utf8");
    }
    const stateFile = path.join(root, "state.json");
    if (!fs.existsSync(stateFile)) {
        writeState(DEFAULT_STATE);
    }
}

/** Reads `name`/`description` from a leading YAML-ish frontmatter block. */
function parseFrontmatter(text: string): { name?: string; description?: string } {
    if (!text.startsWith("---")) {
        return {};
    }
    const end = text.indexOf("\n---", 3);
    if (end === -1) {
        return {};
    }
    const out: { name?: string; description?: string } = {};
    for (const line of text.slice(3, end).split("\n")) {
        const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (m) {
            (out as Record<string, string>)[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    }
    return out;
}

/** Reads name/description for a single-file resource, falling back to the filename. */
function readFileResource(kind: ResourceKind, file: string): ResourceEntry {
    const fallback = path.basename(file).replace(/\.(md|json)$/i, "");
    let meta: { name?: string; description?: string } = {};
    try {
        meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
    } catch {
        // unreadable file: keep filename-only entry
    }
    return {
        kind,
        name: meta.name ?? fallback,
        description: meta.description ?? "",
        path: file,
        bundle: false,
    };
}

/** Reads a skill bundle from its directory (manifest = SKILL.md). */
function readSkillBundle(dir: string): ResourceEntry {
    const manifest = path.join(dir, "SKILL.md");
    const fallback = path.basename(dir);
    let meta: { name?: string; description?: string } = {};
    try {
        meta = parseFrontmatter(fs.readFileSync(manifest, "utf8"));
    } catch {
        // missing/unreadable manifest: keep directory-name entry
    }
    return {
        kind: "skill",
        name: meta.name ?? fallback,
        description: meta.description ?? "",
        path: manifest,
        bundle: true,
    };
}

/** Scans the repo for resources of one kind. Returns [] if the dir is absent. */
export function scanKind(kind: ResourceKind): ResourceEntry[] {
    const dir = path.join(repoDir(), KIND_DIR[kind]);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: ResourceEntry[] = [];
    for (const entry of entries) {
        if (kind === "skill") {
            if (entry.isDirectory()) {
                out.push(readSkillBundle(path.join(dir, entry.name)));
            }
        } else if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) {
            out.push(readFileResource(kind, path.join(dir, entry.name)));
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Scans all resource kinds. */
export function scanAll(): Record<ResourceKind, ResourceEntry[]> {
    return {
        agent: scanKind("agent"),
        skill: scanKind("skill"),
        tool: scanKind("tool"),
        instruction: scanKind("instruction"),
    };
}

export function readState(): SyncState {
    try {
        const raw = fs.readFileSync(path.join(rootDir(), "state.json"), "utf8");
        return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_STATE };
    }
}

export function writeState(state: SyncState): void {
    fs.writeFileSync(path.join(rootDir(), "state.json"), JSON.stringify(state, null, 2), "utf8");
}
