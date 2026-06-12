import * as vscode from "vscode";
import { AgentAdapter, SessionInfo, SessionStartOptions } from "../adapters/types";
import { ChatController } from "./chatController";
import { renderHtml } from "./chatHtml";

interface PendingOpen {
    adapter: AgentAdapter;
    options: SessionStartOptions;
    title: string;
    info?: SessionInfo;
}

/**
 * Sidebar chat surface (WebviewView), stacked under the Sessions tree in
 * the Symposium container — the same layout as the built-in Chat view.
 * Users can drag the Symposium container to the secondary side bar to put
 * sessions + chat on the right, or keep it on the left.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = "symposium.chat";

    private view: vscode.WebviewView | undefined;
    private controller: ChatController | undefined;
    private pending: PendingOpen | undefined;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(
            (message) => void this.controller?.handleMessage(message));
        webviewView.onDidDispose(() => {
            this.controller?.dispose();
            this.controller = undefined;
            this.view = undefined;
        });
        if (this.pending) {
            this.openPending();
        } else {
            webviewView.webview.html = renderHtml();
        }
    }

    /** Opens (or replaces) the dialogue shown in the sidebar chat. */
    async open(adapter: AgentAdapter, options: SessionStartOptions, title: string, info?: SessionInfo): Promise<void> {
        this.pending = { adapter, options, title, info };
        await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
        if (this.view) {
            this.openPending();
        }
        // else: resolveWebviewView fires next and consumes this.pending
    }

    private openPending(): void {
        const pending = this.pending!;
        this.pending = undefined;
        this.controller?.dispose();
        this.view!.title = `${pending.title} · ${pending.adapter.backend}`;
        this.view!.webview.html = renderHtml();
        this.controller = new ChatController(pending.adapter, pending.options, pending.info,
            (message) => void this.view?.webview.postMessage(message));
    }
}
