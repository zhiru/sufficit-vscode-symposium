/**
 * PWA transport shim — the browser drop-in for `./vscode`.
 *
 * `scripts/build-pwa.mjs` aliases every `import … from "./vscode"` in the
 * webview to this module, so the entire chat client runs UNCHANGED in a real
 * browser against the remote bridge (HTTP + SSE) instead of the VS Code host.
 *
 * It preserves the exact 3-symbol contract of `src/ui/webview/vscode.ts`
 * (`vscode`, `saved`, `saveState`) and adds the transport:
 *   - outbound: `vscode.postMessage(msg)` → a bridge REST call (send/interrupt/
 *     create/list), or a no-op for editor-only messages;
 *   - inbound:  a Server-Sent-Events `/follow` stream on the active session,
 *     re-delivered as `window` "message" events so `dispatch.ts` handles them
 *     byte-identically to how the VS Code host posts them;
 *   - state:    `getState`/`setState`/`saved`/`saveState` over `localStorage`.
 *
 * Text-chat MVP: connect, list/switch/create sessions, follow (history + live),
 * send/queue/steer, interrupt. Everything else is a safe no-op — see the router
 * default and README/docs for the endpoints a fuller client still needs.
 */

type Msg = { type: string; [k: string]: any };

const cfg: any = (window as any).__SYMPOSIUM__ ?? {};
const BASE: string = cfg.base ?? "";

const LS_TOKEN = "symposium.bridge.token";
const LS_ACTIVE = "symposium.pwa.activeSession";
const LS_STATE = "symposium.pwa.state";

function token(): string {
    const q = new URLSearchParams(location.search).get("token");
    if (q) { try { localStorage.setItem(LS_TOKEN, q); } catch { /* ignore */ } }
    let t = "";
    try { t = localStorage.getItem(LS_TOKEN) ?? ""; } catch { /* ignore */ }
    if (!t) {
        // One-time prompt on first load; persisted thereafter.
        t = (window.prompt("Symposium bridge token:") || "").trim();
        if (t) { try { localStorage.setItem(LS_TOKEN, t); } catch { /* ignore */ } }
    }
    return t;
}

function authHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${token()}` };
}

async function apiPost(path: string, body?: any): Promise<Response> {
    return fetch(`${BASE}${path}`, {
        method: "POST",
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function apiGet(path: string): Promise<any> {
    const r = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (!r.ok) { throw new Error(`${path} → ${r.status}`); }
    return r.json();
}

// ---- active session id (mirrors the host's "attached session") ----
let activeId: string =
    new URLSearchParams(location.search).get("session") ??
    (() => { try { return localStorage.getItem(LS_ACTIVE) ?? ""; } catch { return ""; } })();

function persistActive(id: string): void {
    try { localStorage.setItem(LS_ACTIVE, id); } catch { /* ignore */ }
}

// ---- inbound: SSE /follow → window "message" ----
let es: EventSource | undefined;

function deliver(obj: any): void {
    // dispatch.ts / voice.ts listen on window "message" and read event.data; this
    // reproduces exactly how the VS Code host delivers a HostToWebview message.
    window.postMessage(obj, "*");
}

function openFollow(id: string): void {
    es?.close();
    es = undefined;
    if (!id) { return; }
    // EventSource cannot set headers, so the token rides as a query param — the
    // bridge accepts a query token ONLY for the /follow route (bridgeAuth.ts).
    es = new EventSource(`${BASE}/sessions/${encodeURIComponent(id)}/follow?token=${encodeURIComponent(token())}`);
    es.onmessage = (e: MessageEvent) => {
        try { deliver(JSON.parse((e as any).data)); } catch { /* keep-alive / non-JSON */ }
    };
    es.onerror = () => { /* browser auto-reconnects; nothing to surface */ };
}

function setActiveId(id: string): void {
    if (!id || id === activeId) { return; }
    activeId = id;
    persistActive(id);
    openFollow(id);
}

// ---- connect (reconstructs the host's ready-branch pushes) ----
let connecting = false;

async function connect(): Promise<void> {
    if (connecting) { return; }
    connecting = true;
    try {
        let sessions: any[] = [];
        try { sessions = await apiGet("/sessions"); } catch { sessions = []; }
        deliver({ type: "sessions", items: sessions });

        if (!activeId && sessions.length) {
            activeId = sessions[0].sessionId || sessions[0].id || "";
            if (activeId) { persistActive(activeId); }
        }

        deliver({ type: "boot", id: "host", label: "Bridge connected", status: "ok" });
        deliver({ type: "setLang", lang: "en" });

        if (!activeId) {
            // No session yet: show the picker so the user can start one.
            const agents = await backendsToAgents();
            deliver({ type: "agent-picker", agents });
            return;
        }

        deliver({ type: "clear" });
        deliver(await composeMeta(activeId, sessions));
        openFollow(activeId);   // SSE log replay carries history + live events

        // Cosmetic panels — safe to start empty (no bridge route yet).
        deliver({ type: "account", profile: null });
        deliver({ type: "tasks", items: [] });
        deliver({ type: "guardrails", items: [] });
        deliver({ type: "commands", items: [] });
    } finally {
        connecting = false;
    }
}

/** Minimal `meta` (see meta.ts:applyMeta) composed from REST — bridge has no
 *  session-meta route yet, so title/permission/reasoning are best-effort. */
async function composeMeta(id: string, sessions: any[]): Promise<Msg> {
    const info = sessions.find((s) => (s.sessionId || s.id) === id) || {};
    let models: string[] = [];
    let backendName: string = info.backendName || info.backend || "";
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        const b = list.find((x) => x.backend === info.backend || x.id === info.backend);
        if (b) {
            models = b.models || (b.model ? [b.model] : []);
            backendName = b.name || b.displayName || backendName;
        }
    } catch { /* models stay empty; send still works */ }

    const modelDefault = info.model || models[0] || "";
    return {
        type: "meta",
        sessionId: id,
        backend: info.backend || "",
        backendName,
        title: info.title || "Session",
        resumed: true,
        models,
        modelDefault,
        sessionModel: info.model || "",
        modelLabels: {},
        reasoningLevels: [],
        reasoningDefault: "",
        permissionModes: ["default"],
        permission: "default",
        whenBusy: "queue",
        busy: false,
        sessionsSide: "auto",
        chatOnly: false,
        agentLabels: null,
        bootstrapLink: null,
        pinnedModels: [],
        browserOpen: false,
        aiTools: undefined,
        cwd: info.cwd || "",
        activeFile: null,
        execDisplay: undefined,
    };
}

async function backendsToAgents(): Promise<any[]> {
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        return list.map((b) => ({
            backend: b.backend || b.id,
            name: b.name || b.displayName || b.backend || b.id,
            version: b.version || "",
            ok: b.available !== false,
        }));
    } catch { return []; }
}

async function refreshSessions(): Promise<void> {
    try { deliver({ type: "sessions", items: await apiGet("/sessions") }); } catch { /* offline */ }
}

async function listBackends(replyType: string): Promise<void> {
    try {
        const backends = await apiGet("/backends");
        const list: any[] = Array.isArray(backends) ? backends : (backends.backends || []);
        deliver({ type: replyType, backends: list });
    } catch { /* offline */ }
}

async function createSession(msg: Msg): Promise<void> {
    // Needs a backend + cwd. The agent picker provides the backend; cwd comes
    // from config or the current session's cwd (no editor to ask in a browser).
    const backend = msg.backend || cfg.defaultBackend;
    const cwd = msg.cwd || cfg.defaultCwd;
    if (!backend || !cwd) {
        deliver({ type: "toast", text: "Remote new-session needs a backend and cwd (not available in the browser yet)." });
        return;
    }
    try {
        const r = await apiPost("/sessions", { backend, cwd });
        const j = await r.json();
        if (j && j.id) { setActiveId(j.id); connect(); }
    } catch { deliver({ type: "toast", text: "Could not start the session." }); }
}

// ---- outbound router (WebviewToHost → bridge REST) ----
function route(msg: Msg): void {
    switch (msg.type) {
        case "ready":
            void connect();
            return;
        case "send":
            if (activeId) { void apiPost(`/sessions/${activeId}/send`, { text: msg.text, mode: msg.mode || "send" }); }
            return;
        case "cancel":
            if (activeId) { void apiPost(`/sessions/${activeId}/interrupt`); }
            return;
        case "refresh-sessions":
            void refreshSessions();
            return;
        case "list-backends":
            void listBackends("backends");
            return;
        case "session-list-backends":
            void listBackends("session-backends");
            return;
        case "new-session":
        case "pick-agent":
            void createSession(msg);
            return;
        case "open-session":
            setActiveId(msg.sessionId);
            return;
        case "session-action":
            if (msg.action === "open") { setActiveId(msg.sessionId); }
            return;
        default:
            // Editor-only / not-yet-supported (attachments, model picker, diff
            // review, approvals, voice, file ops, hub tasks): swallow, never throw.
            return;
    }
}

// A session's real id may only arrive mid-stream (new session); keep the SSE
// pointed at it so a browser reload reconnects to the right session.
window.addEventListener("message", ({ data }: MessageEvent) => {
    const d: any = data;
    if (d && d.type === "event" && d.event && d.event.kind === "session" && d.event.sessionId) {
        setActiveId(d.event.sessionId);
    }
});

// ---- the exported contract (identical shape to ./vscode) ----
export const vscode = {
    postMessage(msg: Msg): void {
        try { route(msg); } catch (err) { console.error("[pwa-shim]", err); }
    },
    getState(): any {
        try { return JSON.parse(localStorage.getItem(LS_STATE) || "null"); } catch { return null; }
    },
    setState(state: any): any {
        try { localStorage.setItem(LS_STATE, JSON.stringify(state)); } catch { /* ignore */ }
        return state;
    },
};

export const saved: any = vscode.getState() || {};

export function saveState(patch: any): void {
    if (vscode.setState) { vscode.setState(Object.assign({}, saved, patch)); }
    Object.assign(saved, patch);
}
