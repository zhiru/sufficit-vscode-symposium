import * as vscode from "vscode";
import { SessionInfo } from "../adapters/types";
import { SessionStore } from "./store";

export class SessionTreeItem extends vscode.TreeItem {
    constructor(readonly info: SessionInfo) {
        super(info.archived ? `🗄 ${info.title}` : info.title, vscode.TreeItemCollapsibleState.None);
        this.description = `${info.backend} · ${info.updatedAt?.toLocaleString() ?? ""}`;
        this.tooltip = `${info.sessionId}\n${info.cwd ?? ""}`;
        this.iconPath = new vscode.ThemeIcon(info.archived ? "archive" : "comment-discussion");
        // contextValue drives which inline/context actions show (see package.json `when`).
        this.contextValue = info.archived ? "session-archived" : "session";
        this.command = {
            command: "symposium.openSession",
            title: "Open Session",
            arguments: [info],
        };
    }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(
        private readonly listSessions: () => Promise<SessionInfo[]>,
    ) { }

    refresh(): void {
        this.emitter.fire();
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<SessionTreeItem[]> {
        const sessions = await this.listSessions();
        return sessions.map((info) => new SessionTreeItem(info));
    }
}
