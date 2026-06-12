import * as vscode from "vscode";
import { AgentAdapter, AgentEvent, AgentSession, SessionInfo, SessionStartOptions } from "../adapters/types";

/**
 * One webview panel hosting one dialogue with one agent session.
 * The webview is a thin renderer; all process state lives here.
 *
 * The input area mirrors the current Copilot Chat layout: attachment
 * chips on top, textarea, and a bottom toolbar with the model picker
 * and the send button. The model can only be chosen before the first
 * message, because it is fixed at process start.
 */
export class ChatPanel {
    private static panels = new Map<string, ChatPanel>();
    private session: AgentSession | undefined;
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
        const created = new ChatPanel(context, adapter, options, title, key);
        ChatPanel.panels.set(key, created);
        if (info && adapter.history) {
            void created.loadHistory(info);
        }
        return created;
    }

    private constructor(
        context: vscode.ExtensionContext,
        private readonly adapter: AgentAdapter,
        private readonly options: SessionStartOptions,
        title: string,
        key: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            "symposium.chat",
            `${title} · ${adapter.backend}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = renderHtml();
        this.panel.onDidDispose(() => {
            this.session?.dispose();
            ChatPanel.panels.delete(key);
        }, undefined, context.subscriptions);

        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
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
        }, undefined, context.subscriptions);

        this.post({
            type: "meta",
            backend: adapter.backend,
            resumed: !!options.resumeSessionId,
            models: adapter.models?.() ?? [],
        });
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

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }
}

function renderHtml(): string {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 0;
    }
    #log { flex: 1; overflow-y: auto; padding: 12px 14px 4px 14px; }
    .msg { margin: 0 0 12px 0; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .user {
        background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
        border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, transparent));
        border-radius: 6px; padding: 8px 10px;
    }
    .user .chips { margin-top: 6px; }
    .tool { opacity: 0.65; font-size: 0.92em; padding-left: 4px; }
    .error { color: var(--vscode-errorForeground); }
    .meta { opacity: 0.5; font-size: 0.85em; text-align: center; }
    .thinking { opacity: 0.6; font-style: italic; }

    /* ---- Copilot-style composer ---- */
    #composer {
        margin: 6px 12px 10px 12px;
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #454545));
        border-radius: 8px;
        background: var(--vscode-input-background);
        display: flex; flex-direction: column;
    }
    #composer:focus-within {
        border-color: var(--vscode-focusBorder);
    }
    #chips {
        display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 0 8px;
    }
    .chip {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 0.85em; padding: 1px 6px;
        border: 1px solid var(--vscode-input-border, #454545);
        border-radius: 4px;
        background: var(--vscode-badge-background, rgba(128,128,128,0.15));
        color: var(--vscode-badge-foreground, inherit);
        max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chip .x { cursor: pointer; opacity: 0.7; }
    .chip .x:hover { opacity: 1; }
    #addContext {
        background: none; border: 1px dashed var(--vscode-input-border, #666);
        color: var(--vscode-descriptionForeground); cursor: pointer;
        border-radius: 4px; font-size: 0.85em; padding: 1px 8px;
    }
    #addContext:hover { color: var(--vscode-foreground); }
    #input {
        border: none; outline: none; resize: none;
        background: transparent; color: var(--vscode-input-foreground);
        font-family: inherit; font-size: inherit;
        padding: 8px 10px; min-height: 38px; max-height: 180px;
    }
    #toolbar {
        display: flex; align-items: center; gap: 6px; padding: 2px 6px 6px 8px;
    }
    #modelPicker {
        background: transparent; color: var(--vscode-descriptionForeground);
        border: none; outline: none; cursor: pointer;
        font-family: inherit; font-size: 0.9em; max-width: 200px;
    }
    #modelPicker:hover:not(:disabled) { color: var(--vscode-foreground); }
    #modelPicker:disabled { cursor: default; opacity: 0.8; }
    #modelPicker option {
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
    }
    #status { flex: 1; text-align: right; opacity: 0.5; font-size: 0.85em; padding-right: 4px; }
    .iconBtn {
        background: none; border: none; cursor: pointer; padding: 3px 5px;
        color: var(--vscode-icon-foreground, var(--vscode-foreground));
        border-radius: 4px; display: inline-flex; align-items: center;
    }
    .iconBtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
    #send svg { width: 16px; height: 16px; }
    #send:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
<div id="log"></div>
<div id="composer">
    <div id="chips">
        <button id="addContext" title="Attach files">📎 Add Context...</button>
    </div>
    <textarea id="input" placeholder="Ask the agent... (Enter sends, Shift+Enter newline)"></textarea>
    <div id="toolbar">
        <select id="modelPicker" title="Model for this session (locked after the first message)"></select>
        <span id="status"></span>
        <button id="send" class="iconBtn" title="Send (Enter)">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.176 2.824 3.06 8 1.176 13.176a.5.5 0 0 0 .708.605l13-5.5a.5.5 0 0 0 0-.918l-13-5.5a.5.5 0 0 0-.708.605L1.176 2.824ZM3.92 8.5 2.32 12.9l10.36-4.4H3.92Zm8.76-1L2.32 3.1l1.6 4.4h8.76Z"/></svg>
        </button>
    </div>
</div>
<script>
    const vscode = acquireVsCodeApi();
    const log = document.getElementById("log");
    const input = document.getElementById("input");
    const chips = document.getElementById("chips");
    const addContext = document.getElementById("addContext");
    const modelPicker = document.getElementById("modelPicker");
    const sendBtn = document.getElementById("send");
    const status = document.getElementById("status");

    let attachments = [];   // [{path, name}]
    let backend = "";
    let activeModel = "";
    let busy = false;

    function append(cls, text) {
        const el = document.createElement("div");
        el.className = "msg " + cls;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
    }

    function setStatus() {
        status.textContent = busy ? "thinking..." : (activeModel ? "model: " + activeModel : "");
    }

    function renderChips() {
        chips.querySelectorAll(".chip").forEach((el) => el.remove());
        for (const file of attachments) {
            const chip = document.createElement("span");
            chip.className = "chip";
            chip.title = file.path;
            chip.textContent = "📄 " + file.name + " ";
            const x = document.createElement("span");
            x.className = "x";
            x.textContent = "✕";
            x.addEventListener("click", () => {
                attachments = attachments.filter((a) => a.path !== file.path);
                renderChips();
            });
            chip.appendChild(x);
            chips.appendChild(chip);
        }
    }

    function send() {
        const text = input.value.trim();
        if (!text || busy) return;
        input.value = "";
        busy = true; sendBtn.disabled = true; setStatus();
        modelPicker.disabled = true;
        vscode.postMessage({
            type: "send",
            text,
            attachments: attachments.map((a) => a.path),
            model: modelPicker.value,
        });
        attachments = [];
        renderChips();
    }

    sendBtn.addEventListener("click", send);
    addContext.addEventListener("click", () => vscode.postMessage({ type: "pick-attachments" }));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        if (e.key === "Escape" && busy) { vscode.postMessage({ type: "cancel" }); }
    });
    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
    });

    window.addEventListener("message", ({ data }) => {
        switch (data.type) {
            case "meta": {
                backend = data.backend;
                for (const m of data.models) {
                    const opt = document.createElement("option");
                    opt.value = m; opt.textContent = m;
                    modelPicker.appendChild(opt);
                }
                if (!data.models.length) modelPicker.style.display = "none";
                append("meta", backend + (data.resumed ? " · resumed session" : " · new session"));
                break;
            }
            case "history": {
                for (const m of data.messages) {
                    if (m.role === "user") append("user", m.text);
                    else if (m.role === "tool") append("tool", m.text);
                    else append("", m.text);
                }
                append("meta", data.messages.length ? "— end of stored transcript —" : "(empty transcript)");
                break;
            }
            case "user": {
                const el = append("user", data.text);
                if (data.attachments?.length) {
                    const list = document.createElement("div");
                    list.className = "chips tool";
                    list.textContent = "📎 " + data.attachments.map((p) => p.split("/").pop()).join(", ");
                    el.appendChild(list);
                }
                break;
            }
            case "attachments-picked": {
                for (const file of data.files) {
                    if (!attachments.some((a) => a.path === file.path)) attachments.push(file);
                }
                renderChips();
                break;
            }
            case "event": {
                const ev = data.event;
                if (ev.kind === "text") append("", ev.text);
                else if (ev.kind === "tool-start") append("tool", "⚙ " + ev.toolName + " " + (ev.detail || ""));
                else if (ev.kind === "error") append("error", "✖ " + ev.message);
                else if (ev.kind === "session") {
                    if (ev.model) { activeModel = ev.model; }
                    append("meta", "session " + ev.sessionId + (ev.model ? " · " + ev.model : ""));
                    setStatus();
                }
                else if (ev.kind === "turn-end") {
                    busy = false; sendBtn.disabled = false; setStatus();
                    append("meta", "—" + (ev.costUsd ? " $" + ev.costUsd.toFixed(4) : "") + (ev.durationMs ? " " + (ev.durationMs/1000).toFixed(1) + "s" : "") + " —");
                }
                break;
            }
        }
    });
    setStatus();
</script>
</body>
</html>`;
}
