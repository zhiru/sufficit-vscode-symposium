import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";

/**
 * Backend-side state of one dialogue, independent of the webview surface
 * (sidebar view or editor panel). Owns the agent process; the webview is a
 * thin renderer fed through `post`.
 */
export class ChatController {
    private session: AgentSession | undefined;

    constructor(
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        info: SessionInfo | undefined,
        private readonly post: (message: unknown) => void,
    ) {
        this.post({
            type: "meta",
            backend: adapter.backend,
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
        });
        if (info && adapter.history) {
            void this.loadHistory(info);
        }
    }

    async handleMessage(message: any): Promise<void> {
        switch (message?.type) {
            case "send":
                this.sendUserMessage(message.text, message.attachments ?? [], message.model);
                break;
            case "cancel":
                this.session?.cancel();
                break;
            case "pick-attachments": {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    openLabel: "Attach",
                    title: "Attach files to the message",
                });
                if (picked?.length) {
                    this.post({
                        type: "attachments-picked",
                        files: picked.map((uri) => ({
                            path: uri.fsPath,
                            name: uri.path.split("/").pop() ?? uri.fsPath,
                        })),
                    });
                }
                break;
            }
        }
    }

    private async loadHistory(info: SessionInfo): Promise<void> {
        try {
            const messages = await this.adapter.history!(info);
            this.post({ type: "history", messages });
        } catch (error) {
            this.post({
                type: "event",
                event: { kind: "error", message: `failed to load history: ${error instanceof Error ? error.message : error}` },
            });
        }
    }

    private sendUserMessage(text: string, attachments: string[], model?: string): void {
        if (!this.session) {
            if (model && model !== "default" && model !== "auto") {
                this.options.model = model;
            }
            this.session = this.adapter.start(this.options);
            this.session.on("event", (event: AgentEvent) => this.post({ type: "event", event }));
        }
        let fullText = text;
        if (attachments.length) {
            fullText += "\n\nAttached files (read them from disk):\n" +
                attachments.map((path) => `- ${path}`).join("\n");
        }
        this.post({ type: "user", text, attachments });
        this.session.send(fullText);
    }

    dispose(): void {
        this.session?.dispose();
        this.session = undefined;
    }
}
