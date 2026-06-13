import * as vscode from "vscode";
import { SessionInfo } from "../adapters/types";

const TITLES_KEY = "symposium.sessionTitles";
const ARCHIVED_KEY = "symposium.archivedSessions";

/**
 * Per-session user metadata kept in the extension's globalState: custom
 * titles (rename) and archived ids. This never touches the transcript
 * files — only permanent delete does. Keyed by `backend:sessionId`.
 */
export class SessionStore {
    private titles: Record<string, string>;
    private archived: Set<string>;

    constructor(private readonly memento: vscode.Memento) {
        this.titles = memento.get<Record<string, string>>(TITLES_KEY, {});
        this.archived = new Set(memento.get<string[]>(ARCHIVED_KEY, []));
    }

    private key(info: SessionInfo): string {
        return `${info.backend}:${info.sessionId}`;
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
