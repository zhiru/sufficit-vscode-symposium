import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { lmToolInvocationOptions } from "../adapters/lmToolInvocation";
import { ResourceKind } from "../config/root";
import { SymposiumApi, SendMode } from "./symposiumApi";
import { isBridgeAuthorized } from "./bridgeAuth";
import { BridgePolicy, resolveBridgePolicy, isCwdAllowed, isHostAllowed, isLmToolAllowed } from "./bridgePolicy";
import { renderPwaHtml } from "../ui/pwaHtml";

/** Static content types for the PWA shell assets. */
const PWA_MIME: Record<string, string> = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
};

/** VS Code commands the bridge is allowed to run (browser/navigation only). */
const ALLOWED_COMMANDS = new Set<string>([
    "simpleBrowser.show",
    "simpleBrowser.api.open",
    "vscode.open",
    "workbench.action.browser.toggleDeviceEmulation",
]);

/**
 * Opt-in remote control bridge. Re-publishes the SymposiumApi facade over a
 * local HTTP server so commands can be issued and a chat session followed from
 * outside the VS Code window (e.g. another machine via an authenticated tunnel).
 *
 * Transport: plain HTTP for commands, Server-Sent Events for the chat stream
 * (no extra dependency). Bound to localhost by default and gated by a bearer
 * token. Off unless `symposium.bridge.enabled` is set.
 */
export class RemoteBridge {
    private server: http.Server | undefined;

    constructor(
        private readonly api: SymposiumApi,
        private readonly log: (msg: string) => void,
    ) { }

    /** Starts the bridge if enabled in settings. Returns the bound URL or null. */
    start(): string | null {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        if (!cfg.get<boolean>("enabled", false)) {
            return null;
        }
        const port = cfg.get<number>("port", 47600);
        const host = cfg.get<string>("host", "127.0.0.1");
        let token = cfg.get<string>("token", "");
        if (!token) {
            token = randomUUID();
            this.log("[bridge] no token configured; generated ephemeral token (see ~/.symposium/bridge.json)");
        }
        if ((cfg.get<string[]>("allowedHosts", []) ?? []).length === 0) {
            this.log("[bridge] symposium.bridge.allowedHosts is empty — Host validation (anti DNS-rebinding) is not enforced; set it once you have a stable tunnel hostname.");
        }

        const url = `http://${host}:${port}`;
        this.server = http.createServer((req, res) => void this.handle(req, res, token));
        this.server.on("error", (err) => {
            this.log(`[bridge] server error: ${err}`);
            removeBridgeAdvertisement();
        });
        this.server.listen(port, host, () => {
            this.log(`[bridge] listening on ${url}`);
            // Publish url+token so local skills/scripts can reach the bridge without
            // hardcoding them, but only after we own the advertised listener.
            try {
                writeBridgeAdvertisement(url, token);
            } catch (err) { this.log(`[bridge] bridge.json write failed: ${err}`); }
        });
        return url;
    }

    stop(): void {
        this.server?.close();
        this.server = undefined;
        removeBridgeAdvertisement();
    }

    private authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
        return isBridgeAuthorized(req.headers.authorization, url, token, req.headers["x-symposium-token"]);
    }

    /** Reads the current server-side policy from settings (fresh each request). */
    private policy(): BridgePolicy {
        const cfg = vscode.workspace.getConfiguration("symposium.bridge");
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        return resolveBridgePolicy({
            allowedRoots: cfg.get<string[]>("allowedRoots", []),
            workspaceRoots,
            sessionPermission: cfg.get<string>("sessionPermission", "acceptEdits"),
            allowedLmTools: cfg.get<string[]>("allowedLmTools", []),
            allowExecutableOverride: cfg.get<boolean>("allowExecutableOverride", false),
            allowVaultResolve: cfg.get<boolean>("allowVaultResolve", false),
            allowedHosts: cfg.get<string[]>("allowedHosts", []),
        });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        const policy = this.policy();
        // Anti DNS-rebinding: reject a mismatched Host before touching the token.
        if (!isHostAllowed(req.headers.host, policy.allowedHosts)) {
            return json(res, 403, { error: "host not allowed" });
        }
        const parts = url.pathname.split("/").filter(Boolean);
        const method = req.method ?? "GET";

        // PWA shell (GET /pwa, /pwa/*) is served UNAUTHENTICATED — it carries no
        // secret and no session data; every data endpoint below stays gated.
        // Opt-in via symposium.bridge.pwa so an operator chooses to serve it.
        if (method === "GET" && parts[0] === "pwa") {
            const cfg = vscode.workspace.getConfiguration("symposium.bridge");
            if (!cfg.get<boolean>("pwa", false)) { return json(res, 404, { error: "not found" }); }
            return this.serveStatic(parts.slice(1).join("/") || "index.html", res);
        }

        if (!this.authorized(req, url, token)) {
            return json(res, 401, { error: "unauthorized" });
        }

        try {
            // GET /health
            if (method === "GET" && parts[0] === "health") {
                return json(res, 200, { ok: true, version: this.api.version });
            }
            // POST /vscode/command  {id, args?}  — run a whitelisted VS Code command
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "command") {
                const body = await readBody(req);
                if (typeof body.id !== "string") { return json(res, 400, { error: "id must be a string" }); }
                if (!ALLOWED_COMMANDS.has(body.id)) { return json(res, 403, { error: `command not allowed: ${body.id}` }); }
                const result = await vscode.commands.executeCommand(body.id, ...(Array.isArray(body.args) ? body.args : []));
                return json(res, 200, { ok: true, result: result ?? null });
            }
            // POST /vscode/lmtool  {name, input?}  — invoke a VS Code Language Model Tool
            if (method === "POST" && parts[0] === "vscode" && parts[1] === "lmtool") {
                const body = await readBody(req);
                if (typeof body.name !== "string") { return json(res, 400, { error: "name must be a string" }); }
                // LM tools can include terminal execution; require an explicit allowlist.
                if (!isLmToolAllowed(body.name, policy.allowedLmTools)) {
                    return json(res, 403, { error: `lm tool not allowed: ${body.name}` });
                }
                const cts = new vscode.CancellationTokenSource();
                try {
                    const input = isRecord(body.input) ? body.input : {};
                    const r = await vscode.lm.invokeTool(body.name, lmToolInvocationOptions(input), cts.token);
                    const content = r.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>;
                    const text = content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p))).join("\n");
                    return json(res, 200, { ok: true, result: text });
                } finally { cts.dispose(); }
            }
            // GET /vscode/lmtools  — list available VS Code Language Model Tools
            if (method === "GET" && parts[0] === "vscode" && parts[1] === "lmtools") {
                const tools = (vscode.lm?.tools ?? []).map((t) => ({ name: t.name, description: t.description, tags: t.tags }));
                return json(res, 200, tools);
            }
            // GET /sessions/all  — full tree (stored + live), like the sidebar
            if (method === "GET" && parts[0] === "sessions" && parts[1] === "all" && parts.length === 2) {
                return json(res, 200, await this.api.sessions.listAll());
            }
            // GET /sessions  — live sessions only
            if (method === "GET" && parts[0] === "sessions" && parts.length === 1) {
                return json(res, 200, this.api.sessions.list());
            }
            // POST /sessions  {backend, cwd, model?, tools?}
            if (method === "POST" && parts[0] === "sessions" && parts.length === 1) {
                const body = await readBody(req);
                if (typeof body.backend !== "string" || typeof body.cwd !== "string") { return json(res, 400, { error: "backend and cwd are required strings" }); }
                // A remote spawn is arbitrary code execution: confine the cwd to the
                // allowed roots and force a non-bypass permission mode.
                if (!isCwdAllowed(body.cwd, policy.allowedRoots)) {
                    return json(res, 403, { error: "cwd not allowed" });
                }
                const options: { cwd: string; model?: string; tools?: string[]; agent?: string; permission?: string } = {
                    cwd: body.cwd,
                    model: typeof body.model === "string" ? body.model : undefined,
                    tools: Array.isArray(body.tools) ? body.tools : undefined,
                    agent: typeof body.agent === "string" ? body.agent : undefined,
                    permission: policy.sessionPermission,
                };
                const id = await this.api.sessions.create(body.backend, options);
                return id ? json(res, 200, { id }) : json(res, 400, { error: "unknown backend" });
            }
            // POST /sessions/:id/send  {text, mode?}
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "send") {
                const body = await readBody(req);
                if (typeof body.text !== "string") { return json(res, 400, { error: "text must be a string" }); }
                const ok = this.api.sessions.send(parts[1], body.text, body.mode as SendMode);
                return json(res, ok ? 200 : 404, { ok });
            }
            // POST /sessions/:id/interrupt
            if (method === "POST" && parts[0] === "sessions" && parts[2] === "interrupt") {
                const ok = this.api.sessions.interrupt(parts[1]);
                return json(res, ok ? 200 : 404, { ok });
            }
            // GET /sessions/:id/follow  (SSE)
            if (method === "GET" && parts[0] === "sessions" && parts[2] === "follow") {
                return this.follow(parts[1], res);
            }
            // GET /resources
            if (method === "GET" && parts[0] === "resources" && parts.length === 1) {
                return json(res, 200, this.api.resources.scan());
            }
            // POST /resources  {kind, name, description?}  | /resources/seed
            if (method === "POST" && parts[0] === "resources") {
                if (parts[1] === "seed") {
                    return json(res, 200, { created: this.api.resources.seed() });
                }
                const body = await readBody(req);
                if (typeof body.kind !== "string" || typeof body.name !== "string") { return json(res, 400, { error: "kind and name are required strings" }); }
                const description = typeof body.description === "string" ? body.description : undefined;
                const path = this.api.resources.create(body.kind as ResourceKind, body.name, description);
                return json(res, 200, { path });
            }
            // DELETE /resources/:kind/:name
            if (method === "DELETE" && parts[0] === "resources" && parts.length === 3) {
                const name = decodeURIComponent(parts[2]);
                if (!name) { return json(res, 400, { error: "invalid resource name" }); }
                this.api.resources.remove(parts[1] as ResourceKind, name);
                return json(res, 200, { ok: true });
            }
            // GET /backends
            if (method === "GET" && parts[0] === "backends" && parts.length === 1) {
                return json(res, 200, await this.api.backends.list());
            }
            // POST /backends/:backend/test
            if (method === "POST" && parts[0] === "backends" && parts[2] === "test") {
                const s = await this.api.backends.test(parts[1]);
                return json(res, s ? 200 : 404, s ?? { error: "unknown backend" });
            }
            // POST /backends/:backend/model  {value}
            if (method === "POST" && parts[0] === "backends" && parts[2] === "model") {
                const body = await readBody(req);
                const value = typeof body.value === "string" ? body.value : "";
                const ok = await this.api.backends.setModel(parts[1], value);
                return json(res, ok ? 200 : 400, { ok });
            }
            // POST /backends/:backend/executable  {value}
            if (method === "POST" && parts[0] === "backends" && parts[2] === "executable") {
                // Rewriting the spawn binary is a clean RCE primitive; off unless opted in.
                if (!policy.allowExecutableOverride) {
                    return json(res, 403, { error: "executable override disabled over bridge" });
                }
                const body = await readBody(req);
                const value = typeof body.value === "string" ? body.value : "";
                const ok = await this.api.backends.setExecutable(parts[1], value);
                return json(res, ok ? 200 : 400, { ok });
            }
            // GET /sync
            if (method === "GET" && parts[0] === "sync" && parts.length === 1) {
                return json(res, 200, this.api.sync.status());
            }
            // GET /sync/health
            if (method === "GET" && parts[0] === "sync" && parts[1] === "health") {
                return json(res, 200, { healthy: await this.api.sync.health() });
            }
            // POST /sync/pull | /sync/push
            if (method === "POST" && parts[0] === "sync" && parts[1] === "pull") {
                return json(res, 200, await this.api.sync.pull());
            }
            if (method === "POST" && parts[0] === "sync" && parts[1] === "push") {
                return json(res, 200, await this.api.sync.push());
            }
            // GET /vault/resolve?reference=
            if (method === "GET" && parts[0] === "vault" && parts[1] === "resolve") {
                // Direct secret read: off unless explicitly opted in.
                if (!policy.allowVaultResolve) {
                    return json(res, 403, { error: "vault resolve disabled over bridge" });
                }
                const value = await this.api.vault.resolve(url.searchParams.get("reference") ?? "");
                return value == null
                    ? json(res, 404, { error: "unknown/expired/offline" })
                    : json(res, 200, { value });
            }
            return json(res, 404, { error: "not found" });
        } catch (err) {
            // Log the detail server-side; a generic 500 avoids leaking absolute
            // paths / usernames from fs/spawn errors to the remote caller.
            this.log(`[bridge] request error: ${String(err)}`);
            return json(res, 500, { error: "internal error" });
        }
    }

    /**
     * Serves the unauthenticated PWA shell from out/pwa. index.html is generated
     * (renderPwaHtml, no embedded token); other assets are read from disk with a
     * traversal guard. Unknown paths fall back to the app (SPA boot).
     */
    private serveStatic(rel: string, res: http.ServerResponse): void {
        if (rel === "index.html" || rel === "") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderPwaHtml());
            return;
        }
        const roots = path.join(__dirname, "pwa");
        const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
        const file = path.join(roots, safe);
        if (file !== roots && !file.startsWith(roots + path.sep)) {
            return json(res, 403, { error: "forbidden" });
        }
        let body: Buffer;
        try {
            body = fs.readFileSync(file);
        } catch {
            // SPA fallback: unknown path boots the app.
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderPwaHtml());
            return;
        }
        const headers: Record<string, string> = {
            "Content-Type": PWA_MIME[path.extname(file)] ?? "application/octet-stream",
        };
        if (path.basename(file) === "sw.js") { headers["Service-Worker-Allowed"] = "/pwa/"; }
        res.writeHead(200, headers);
        res.end(body);
    }

    /** Opens an SSE stream that mirrors a session's chat to the remote viewer. */
    private follow(id: string, res: http.ServerResponse): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        res.write(`event: open\ndata: ${JSON.stringify({ id })}\n\n`);
        const unsubscribe = this.api.sessions.follow(id, (message) => {
            res.write(`data: ${JSON.stringify(message)}\n\n`);
        });
        if (!unsubscribe) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "unknown session" })}\n\n`);
            res.end();
            return;
        }
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
    }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let data = "";
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) { return; }
            data += chunk;
            if (data.length > 1_000_000) {
                tooLarge = true;
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (tooLarge) { return; }
            try {
                resolve((data ? JSON.parse(data) : {}) as Record<string, unknown>);
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function bridgeAdvertisementPath(): string {
    return path.join(os.homedir(), ".symposium", "bridge.json");
}

function writeBridgeAdvertisement(url: string, token: string): void {
    const filePath = bridgeAdvertisementPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ url, token }), { mode: 0o600 });
}

function removeBridgeAdvertisement(): void {
    try { fs.rmSync(bridgeAdvertisementPath(), { force: true }); } catch { /* ignore */ }
}
