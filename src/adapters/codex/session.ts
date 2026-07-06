import { spawn } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveExecutable } from "../exec";
import { contextWindowFor, parseCodexUsage } from "../parse";
import { parseNativeTodos } from "../todos";
import { AgentSession, SessionStartOptions } from "../types";

export interface CodexAdapterConfig {
    executable: string;
    model: string;
    reasoning: string;
    approvalPolicy: string;
    sandboxMode: string;
    /** Add the Playwright MCP server (browser navigation tools). */
    playwright?: boolean;
    /** Extra MCP servers ({ name: { command, args } }). */
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

/**
 * Reads VSCode's mcp.json (~/.config/Code/User/mcp.json on Linux, appropriate
 * location on Windows/macOS) and converts MCP servers to CLI-compatible format
 * for Codex. HTTP servers are converted to a command+args wrapper that uses
 * curl to communicate with the server via stdin/stdout.
 */
function loadVscodeMcpServers(): Record<string, { command: string; args: string[] }> {
    const result: Record<string, { command: string; args: string[] }> = {};
    try {
        let configPath: string;
        const platform = os.platform();
        if (platform === "linux" || platform === "darwin") {
            configPath = path.join(os.homedir(), ".config", "Code", "User", "mcp.json");
        } else if (platform === "win32") {
            configPath = path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "mcp.json");
        } else {
            return result; // Unsupported platform
        }
        
        if (!fs.existsSync(configPath)) {
            return result;
        }
        
        const configContent = fs.readFileSync(configPath, "utf8");
        const config = JSON.parse(configContent);
        
        if (!config.servers || typeof config.servers !== "object") {
            return result;
        }
        
        for (const [name, server] of Object.entries(config.servers)) {
            const s = server as Record<string, unknown>;
            if (s.type === "http" && s.url && typeof s.url === "string") {
                // HTTP MCP servers need to communicate via HTTP POST. The
                // wrapper reads url/headers from mcp.json at runtime so secrets
                // are not baked into generated code under ~/.symposium.
                const wrapperPath = mcpHttpWrapperPath(name);
                const wrapperScript = buildHttpMcpWrapperScript(configPath, name);
                const dir = path.dirname(wrapperPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(wrapperPath, wrapperScript, { encoding: "utf8", mode: 0o600 });
                fs.chmodSync(wrapperPath, 0o600);
                result[name] = { command: "node", args: [wrapperPath] };
            } else if (s.type === "stdio" && s.command && typeof s.command === "string") {
                const args: string[] = [];
                if (Array.isArray(s.args)) {
                    args.push(...s.args);
                }
                result[name] = { command: s.command, args };
            }
        }
    } catch (error) {
        // Silently fail on errors - MCP is optional
        console.error(`[codex] Failed to load VSCode MCP config: ${error}`);
    }
    return result;
}

export function mcpHttpWrapperPath(name: string): string {
    const safeName = encodeURIComponent(name) || "server";
    return path.join(os.homedir(), ".symposium", `mcp-http-${safeName}.js`);
}

export function buildHttpMcpWrapperScript(configPath: string, serverName: string): string {
    return `
const fs = require('fs');
const http = require('http');
const https = require('https');
const readline = require('readline');

const CONFIG_PATH = ${JSON.stringify(configPath)};
const SERVER_NAME = ${JSON.stringify(serverName)};

function loadServerConfig() {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const servers = config && typeof config === 'object' ? config.servers : undefined;
    const server = servers && servers[SERVER_NAME];
    if (!server || typeof server.url !== 'string') {
        throw new Error('HTTP MCP server not found in mcp.json: ' + SERVER_NAME);
    }
    const headers = {};
    if (server.headers && typeof server.headers === 'object') {
        for (const [k, v] of Object.entries(server.headers)) {
            headers[k] = String(v);
        }
    }
    return { targetUrl: server.url, headers };
}

async function makeRequest(data) {
    const { targetUrl, headers } = loadServerConfig();
    const client = new URL(targetUrl).protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = client.request(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(body);
                }
            });
        });
        
        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    try {
        const data = JSON.parse(line);
        const response = await makeRequest(data);
        console.log(JSON.stringify(response));
    } catch (err) {
        console.error(JSON.stringify({ error: err.message }));
    }
});
`;
}

/**
 * Drives the Codex CLI through `codex exec --json` (JSONL events), one
 * process per turn. Continuity uses `codex exec resume <session-id>`; the
 * session id arrives in the `thread.started` event. Sessions are stored as
 * rollout-*.jsonl under ~/.codex/sessions/YYYY/MM/DD.
 */
export class CodexSession extends EventEmitter implements AgentSession {
    readonly backend = "codex" as const;
    sessionId: string | undefined;
    private current: ReturnType<typeof spawn> | undefined;
    private disposed = false;
    private reportedError = false;
    private vscodeMcpServers: Record<string, { command: string; args: string[] }>;

    constructor(
        private readonly config: CodexAdapterConfig,
        private readonly options: SessionStartOptions,
    ) {
        super();
        this.vscodeMcpServers = loadVscodeMcpServers();
        this.sessionId = options.resumeSessionId;
    }

    send(text: string): void {
        // A mid-turn send must not leave two `codex exec` processes writing
        // the same rollout. Cancel the in-flight child before starting another.
        if (this.current) {
            this.current.kill("SIGINT");
            this.current = undefined;
        }
        const base = ["exec", "--json", "--skip-git-repo-check"];
        const model = this.options.model || this.config.model;
        if (model) {
            base.push("--model", model);
        }
        const approvalPolicy = this.options.permission || this.config.approvalPolicy;
        if (approvalPolicy && approvalPolicy !== "default") {
            base.push("--approval-policy", approvalPolicy);
        }
        const sandboxMode = this.config.sandboxMode;
        if (sandboxMode && sandboxMode !== "default") {
            base.push("--sandbox-mode", sandboxMode);
        }
        const reasoning = this.options.reasoning || this.config.reasoning;
        if (reasoning && reasoning !== "default") {
            base.push("-c", `model_reasoning_effort="${reasoning}"`);
        }
        // MCP servers (Playwright browser tools + extras + VSCode MCP servers) as `-c` TOML overrides.
        const servers: Record<string, { command?: string; args?: string[] }> = { ...(this.config.mcpServers ?? {}) };
        if (this.config.playwright && !servers.playwright) {
            servers.playwright = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
        }
        // Merge VSCode MCP servers (from mcp.json), letting explicit config override
        for (const [name, server] of Object.entries(this.vscodeMcpServers)) {
            if (!servers[name]) {
                servers[name] = server;
            }
        }
        for (const [name, s] of Object.entries(servers)) {
            if (s.command) { base.push("-c", `mcp_servers.${name}.command=${JSON.stringify(s.command)}`); }
            if (s.args) { base.push("-c", `mcp_servers.${name}.args=${JSON.stringify(s.args)}`); }
        }
        // `resume <id>` must precede the prompt; a fresh turn just passes the prompt.
        const args = this.sessionId
            ? [...base, "resume", this.sessionId, text]
            : [...base, text];

        const child = spawn(resolveExecutable(this.config.executable), args, {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.current = child;
        this.reportedError = false;

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
            if (this.current === child) {
                this.handleLine(line);
            }
        });

        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => {
            if (this.current !== child) {
                return;
            }
            this.current = undefined;
            this.emit("event", { kind: "error", message: `codex spawn failed: ${error.message}` });
            this.emit("event", { kind: "turn-end" });
        });
        child.on("exit", (code) => {
            if (this.current !== child) {
                return;
            }
            this.current = undefined;
            if (this.disposed) {
                return;
            }
            if (code !== 0 && code !== null && !this.reportedError) {
                const detail = stderr.trim().split("\n").slice(-2).join(" ");
                this.emit("event", { kind: "error", message: `codex exited with code ${code}: ${detail}` });
            }
            this.emit("event", { kind: "turn-end" });
        });
    }

    private handleLine(line: string): void {
        if (!line.trim()) {
            return;
        }
        let event: { type: string; [key: string]: unknown };
        try {
            event = JSON.parse(line);
        } catch {
            return; // non-JSON log lines (codex prints some ERROR lines plainly)
        }
        switch (event.type) {
            case "thread.started":
                if (typeof event.thread_id === "string" && !this.sessionId) {
                    this.sessionId = event.thread_id;
                    this.emit("event", { kind: "session", sessionId: event.thread_id });
                }
                break;
            case "item.started":
            case "item.completed": {
                const item = typeof event.item === "object" && event.item !== null ? event.item as Record<string, unknown> : {};
                const itemType = typeof item.type === "string" ? item.type : (typeof item.item_type === "string" ? item.item_type : undefined);
                // Codex's plan/todo updates (e.g. update_plan / todo_list).
                const todos = parseNativeTodos(itemType ?? "", item);
                if (todos) {
                    this.emit("event", { kind: "tool-start", toolName: "TodoWrite", detail: "", todos });
                    break;
                }
                if (event.type !== "item.completed") {
                    if (itemType === "command_execution" && typeof item.command === "string") {
                        this.emit("event", { kind: "tool-start", toolName: "exec", detail: item.command.slice(0, 120) });
                    }
                    break;
                }
                if (itemType === "agent_message" && typeof item.text === "string") {
                    this.emit("event", { kind: "text", text: item.text });
                } else if (itemType === "reasoning" && typeof item.text === "string") {
                    this.emit("event", { kind: "text", text: item.text });
                } else if (itemType === "command_execution" && typeof item.command === "string") {
                    this.emit("event", { kind: "tool-end", toolName: "exec", detail: item.command });
                } else if (itemType === "file_change" || itemType === "mcp_tool_call" || itemType === "web_search") {
                    this.emit("event", { kind: "tool-end", toolName: itemType });
                }
                break;
            }
            case "token_count":
                // Streamed during a turn (event_msg/token_count). Carries the
                // richest usage incl. model_context_window — surface it live so
                // the Context Window meter fills before the turn even ends.
                this.emitUsage(event);
                break;
            case "turn.completed":
                // turn.completed may carry { usage: {...} }. Emit usage (if any)
                // BEFORE turn-end so the meter reflects the final totals.
                this.emitUsage(event);
                this.emit("event", { kind: "turn-end" });
                break;
            case "turn.failed": {
                this.reportedError = true;
                const error = typeof event.error === "object" && event.error !== null ? event.error as Record<string, unknown> : {};
                this.emit("event", { kind: "error", message: "message" in error && typeof error.message === "string" ? error.message : "codex turn failed" });
                this.emit("event", { kind: "turn-end" });
                break;
            }
            case "error": {
                const message = typeof event.message === "string" ? event.message : "codex error";
                // "Reconnecting... N/5" are transient retry notices, not failures;
                // the terminal error (or turn.failed) is surfaced separately.
                if (/^Reconnecting\.\.\./.test(message)) {
                    break;
                }
                this.reportedError = true;
                this.emit("event", { kind: "error", message });
                break;
            }
        }
    }

    /**
     * Normalize a Codex usage-bearing event and emit a `usage` UI event. Falls
     * back to the configured model's context window when Codex doesn't report
     * one (older exec streams omit model_context_window).
     */
    private emitUsage(event: unknown): void {
        const u = parseCodexUsage(event);
        if (!u) { return; }
        this.emit("event", {
            kind: "usage",
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheRead: u.cacheRead,
            contextWindow: u.contextWindow ?? contextWindowFor(this.options.model || this.config.model),
        });
    }

    cancel(): void {
        this.current?.kill("SIGINT");
    }

    dispose(): void {
        this.disposed = true;
        this.current?.kill();
        this.current = undefined;
        this.removeAllListeners();
    }
}
