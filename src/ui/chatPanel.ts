import * as vscode from "vscode";
import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { renderHtml } from "./chatHtml";

/** One editor webview panel hosting one dialogue with one agent session. */
export class ChatPanel {
    private static panels = new Map<string, ChatPanel>();
    private readonly controller: ChatController;
    private readonly panel: vscode.WebviewPanel;

    static open(
        context: vscode.ExtensionContext,
        adapter: AgentAdapter,
        options: SessionStartOptions,
        title: string,
        info?: SessionInfo,
    ): ChatPanel {
        const key = `${adapter.backend}:${options.resumeSessionId ?? Date.now()}`;
        const existing = ChatPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal();
            return existing;
        }
        const created = new ChatPanel(context, adapter, options, title, key, info);
        ChatPanel.panels.set(key, created);
        return created;
    }

    private constructor(
        context: vscode.ExtensionContext,
        adapter: AgentAdapter,
        options: SessionStartOptions,
        title: string,
        key: string,
        info?: SessionInfo,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            "symposium.chat",
            `${title} · ${adapter.backend}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderHtml();
        this.controller = new ChatController(adapter, options, info,
            (message) => void this.panel.webview.postMessage(message));
        this.panel.webview.onDidReceiveMessage(
            (message) => void this.controller.handleMessage(message),
            undefined, context.subscriptions);
        this.panel.onDidDispose(() => {
            this.controller.dispose();
            ChatPanel.panels.delete(key);
        }, undefined, context.subscriptions);
    }
}
