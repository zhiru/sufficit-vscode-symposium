import * as vscode from "vscode";
import { SessionInfo } from "../adapters/types";

const TITLES_KEY = "symposium.sessionTitles";
const ARCHIVED_KEY = "symposium.archivedSessions";

/** Old keys were `backend:guid`; strip the backend prefix to the bare GUID. */
function toGuid(key: string): string {
    const colon = key.indexOf(":");
    return colon === -1 ? key : key.slice(colon + 1);
}
function migrateKeys(map: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        out[toGuid(k)] = v;
    }
    return out;
}
function migrateList(list: string[]): string[] {
    return list.map(toGuid);
}

/**
 * Per-session user metadata kept in the extension's globalState: custom
 * titles (rename) and archived ids. This never touches the transcript
 * files — only permanent delete does.
 *
 * Keyed by the session GUID alone. Every backend (Claude, Codex, Copilot)
 * issues globally-unique UUID session ids, so the GUID is the canonical,
 * backend-agnostic key — the same id that will later link a session to the
 * Sufficit memory system.
 */
export class SessionStore {
    private titles: Record<string, string>;
    private archived: Set<string>;

    constructor(private readonly memento: vscode.Memento) {
        const rawTitles = memento.get<Record<string, string>>(TITLES_KEY, {});
        const rawArchived = memento.get<string[]>(ARCHIVED_KEY, []);
        this.titles = migrateKeys(rawTitles);
        this.archived = new Set(migrateList(rawArchived));
        // Consolidate legacy `backend:guid` keys to the bare GUID on disk.
        if (Object.keys(rawTitles).some((k) => k.includes(":"))) {
            void memento.update(TITLES_KEY, this.titles);
        }
        if (rawArchived.some((k) => k.includes(":"))) {
            void memento.update(ARCHIVED_KEY, [...this.archived]);
        }
    }

    private key(info: SessionInfo): string {
        return info.sessionId;
    }

    customTitle(info: SessionInfo): string | undefined {
        return this.titles[this.key(info)];
    }

    async setTitle(info: SessionInfo, title: string | undefined): Promise<void> {
        if (title && title.trim()) {
            this.titles[this.key(info)] = title.trim();
        } else {
            delete this.titles[this.key(info)];
        }
        await this.memento.update(TITLES_KEY, this.titles);
    }

    isArchived(info: SessionInfo): boolean {
        return this.archived.has(this.key(info));
    }

    async setArchived(info: SessionInfo, archived: boolean): Promise<void> {
        if (archived) {
            this.archived.add(this.key(info));
        } else {
            this.archived.delete(this.key(info));
        }
        await this.memento.update(ARCHIVED_KEY, [...this.archived]);
    }

    /** Drops all stored metadata for a session (used after permanent delete). */
    async forget(info: SessionInfo): Promise<void> {
        delete this.titles[this.key(info)];
        this.archived.delete(this.key(info));
        await this.memento.update(TITLES_KEY, this.titles);
        await this.memento.update(ARCHIVED_KEY, [...this.archived]);
    }

    /** Applies custom titles and the archived flag, then filters by showArchived. */
    decorate(sessions: SessionInfo[], showArchived: boolean): SessionInfo[] {
        return sessions
            .map((s) => ({
                ...s,
                title: this.customTitle(s) ?? s.title,
                archived: this.isArchived(s),
            }))
            .filter((s) => showArchived || !s.archived);
    }
}
