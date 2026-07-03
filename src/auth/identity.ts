import * as vscode from "vscode";

/**
 * Sufficit Identity login for Symposium via OAuth 2.0 Device Authorization Grant
 * against the Duende IdentityServer at identity.sufficit.com.br. Device flow is
 * used because it needs no redirect URI — works in desktop VS Code and code-server.
 *
 * Tokens live in SecretStorage (never settings.json). The profile (name/email/
 * avatar) comes from /connect/userinfo. These credentials are the basis for
 * memory/MCP access.
 *
 * Requires a public OAuth client registered in identity with the device_code
 * grant enabled and scopes openid/profile/email/offline_access. The client id is
 * read from `symposium.identity.clientId`.
 */

export interface SufficitProfile {
    sub?: string;
    name?: string;
    email?: string;
    picture?: string;
}

interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAtMs: number;
}

interface Discovery {
    token_endpoint: string;
    device_authorization_endpoint?: string;
    userinfo_endpoint?: string;
}

const SECRET_KEY = "sufficit.identity.tokens";
const PROFILE_KEY = "sufficit.identity.profile";
/**
 * Fallback home for the tokens when SecretStorage does not persist (most often
 * the VS Code snap, which is isolated from the host keyring and silently falls
 * back to an in-memory store that is lost on restart). Stored in globalState,
 * which is backed by a per-extension SQLite DB that survives restarts and is
 * NOT covered by Settings Sync — so credentials persist locally but never roam
 * to other machines. Less isolated than the OS keyring, but strictly better
 * than losing the login every restart.
 */
const FALLBACK_KEY = "sufficit.identity.tokens.fallback";

export class SufficitAuth {
    private profileCache: SufficitProfile | undefined;
    private readonly onChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.onChangeEmitter.event;
    // Guards the "session expired" notification so a flapping token or repeated
    // requests don't spam the user with the same prompt.
    private expiredNoticeShown = false;
    // Guards the "credentials not persisted to keyring" notice (shown once per
    // login that landed in the globalState fallback).
    private persistNoticeShown = false;
    /**
     * Whether SecretStorage actually persists. Probed once on the first write
     * via a read-back round-trip; while it stays `undefined` we don't know yet,
     * and once probed the value is cached so the config panel's banner reflects
     * the real situation without re-probing on every read.
     */
    private secretStoragePersists: boolean | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (msg: string) => void = () => { },
    ) { }

    private cfg() {
        return vscode.workspace.getConfiguration("symposium.identity");
    }
    private issuer(): string {
        const v = this.cfg().get<string>("url", "");
        return (v && v.trim() ? v : "https://identity.sufficit.com.br").replace(/\/+$/, "");
    }
    private clientId(): string {
        // Public OAuth client id (not a secret) — baked in so login works out of
        // the box; override via settings only for a custom identity tenant.
        const v = this.cfg().get<string>("clientId", "");
        return v && v.trim() ? v : "sufficit-vscode-symposium";
    }
    private scope(): string {
        return this.cfg().get<string>("scope", "openid profile email offline_access");
    }

    private async discovery(): Promise<Discovery> {
        const url = `${this.issuer()}/.well-known/openid-configuration`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`discovery failed: ${res.status} (${url})`);
        }
        return (await res.json()) as Discovery;
    }

    async isLoggedIn(): Promise<boolean> {
        return (await this.readTokens()) !== undefined;
    }

    /** Interactive device-code login. Returns the profile on success. */
    async login(): Promise<SufficitProfile | undefined> {
        const clientId = this.clientId();
        if (!clientId) {
            void vscode.window.showErrorMessage("Configure symposium.identity.clientId (client OAuth registrado no Sufficit Identity).");
            return undefined;
        }
        const disco = await this.discovery();
        if (!disco.device_authorization_endpoint) {
            throw new Error("Identity does not advertise device_authorization_endpoint.");
        }

        // 1. Request a device + user code.
        const devRes = await fetch(disco.device_authorization_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: clientId, scope: this.scope() }).toString(),
        });
        const dev = await devRes.json() as { verification_uri_complete?: string; verification_uri?: string; user_code: string; error?: string; device_code?: string; interval?: number; expires_in?: number };
        if (!devRes.ok) {
            throw new Error(`device authorization failed: ${dev.error ?? devRes.status}`);
        }

        const verifyUrl: string = dev.verification_uri_complete ?? dev.verification_uri ?? "";
        const pick = await vscode.window.showInformationMessage(
            `Sufficit: open the browser and confirm the code ${dev.user_code}`, "Open browser");
        if (pick) {
            await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));
        }

        // 2. Poll the token endpoint until the user approves (or timeout).
        if (!dev.device_code) { return undefined; }
        const tokens = await this.pollToken(disco.token_endpoint, clientId, dev.device_code, dev.interval ?? 5, dev.expires_in ?? 300);
        if (!tokens) {
            return undefined;
        }
        await this.writeTokens(tokens);
        this.profileCache = undefined;
        const profile = await this.getProfile(true);
        this.onChangeEmitter.fire();
        // If SecretStorage does not persist (no system keyring available — e.g.
        // code-server on a headless server, a container, or the VS Code snap),
        // reassure the user once: the login still works and is saved locally.
        // This is informational, not an error — the globalState fallback keeps
        // the tokens across restarts. The Sufficit tab shows a standing banner
        // with the same note.
        if (this.secretStoragePersists === false && !this.persistNoticeShown) {
            this.persistNoticeShown = true;
            void vscode.window.showInformationMessage(
                "Sufficit: login salvo. Este ambiente não tem chaveiro do sistema, então suas credenciais ficam no armazenamento local da extensão (mantidas entre reinícios, menos isoladas que um chaveiro).",
            );
        }
        return profile;
    }

    private async pollToken(tokenEndpoint: string, clientId: string, deviceCode: string, intervalSec: number, expiresInSec: number): Promise<StoredTokens | undefined> {
        const deadline = Date.now() + expiresInSec * 1000;
        let interval = intervalSec;
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Sufficit: waiting for approval in the browser…", cancellable: true },
            async (_p, token) => {
                while (Date.now() < deadline && !token.isCancellationRequested) {
                    await new Promise((r) => setTimeout(r, interval * 1000));
                    const res = await fetch(tokenEndpoint, {
                        method: "POST",
                        headers: { "content-type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                            device_code: deviceCode,
                            client_id: clientId,
                        }).toString(),
                    });
                    const j = await res.json() as { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
                    if (res.ok) {
                        return this.toStored(j);
                    }
                    if (j.error === "authorization_pending") { continue; }
                    if (j.error === "slow_down") { interval += 5; continue; }
                    this.log(`[auth] device token error: ${j.error}`);
                    throw new Error(j.error_description ?? j.error ?? "device login failed");
                }
                return undefined;
            });
    }

    private toStored(j: { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string }): StoredTokens {
        return {
            accessToken: j.access_token ?? "",
            refreshToken: j.refresh_token,
            idToken: j.id_token,
            expiresAtMs: Date.now() + ((j.expires_in ?? 3600) * 1000),
        };
    }

    private async readTokens(): Promise<StoredTokens | undefined> {
        const raw = await this.context.secrets.get(SECRET_KEY);
        if (raw) {
            try { return JSON.parse(raw) as StoredTokens; } catch { /* malformed */ }
        }
        // Fallback (VS Code snap and other keyring-less setups): tokens kept in
        // globalState so the login survives a restart even when SecretStorage is
        // backed by an in-memory store. Same shape as the secret payload.
        const fallback = this.context.globalState.get<string>(FALLBACK_KEY);
        if (fallback) {
            try { return JSON.parse(fallback) as StoredTokens; } catch { /* malformed */ }
        }
        return undefined;
    }
    private async writeTokens(t: StoredTokens): Promise<void> {
        const payload = JSON.stringify(t);
        await this.context.secrets.store(SECRET_KEY, payload);
        // Probe persistence once: read it straight back. If the secret is gone
        // (the snap's in-memory SecretStorage doesn't survive even within the
        // session, or the keyring silently dropped it), fall back to globalState
        // and remember the verdict so the config banner can warn the user.
        if (this.secretStoragePersists === undefined) {
            const readBack = await this.context.secrets.get(SECRET_KEY);
            this.secretStoragePersists = readBack === payload;
        }
        if (this.secretStoragePersists) {
            // Keep the fallback clean while the keyring works, so we never leave
            // a stale copy behind.
            await this.context.globalState.update(FALLBACK_KEY, undefined);
        } else {
            await this.context.globalState.update(FALLBACK_KEY, payload);
        }
    }

    /**
     * Whether SecretStorage actually persists across restarts on this machine.
     * Undefined until probed (the first token write), then true/false. The
     * config panel shows a warning banner and the login flow warns when this is
     * false — typically the VS Code snap (isolated from the host keyring) where
     * tokens would otherwise vanish on every restart.
     */
    async isSecretStorageWorking(): Promise<boolean> {
        if (this.secretStoragePersists === undefined) {
            // Probe with a throwaway marker so the verdict is known even before
            // the first real login (the banner should show on first install too).
            const marker = "symposium-probe";
            await this.context.secrets.store(SECRET_KEY, marker);
            this.secretStoragePersists = (await this.context.secrets.get(SECRET_KEY)) === marker;
        }
        return this.secretStoragePersists;
    }

    /**
     * Valid access token, refreshing automatically when it has expired. Returns
     * null when not logged in. When the access token has expired AND cannot be
     * refreshed (no refresh token, or the refresh was rejected), the stored
     * tokens are cleared, the cached profile is dropped (so the UI stops showing
     * a logged-in avatar), the user is notified once with an action to sign in
     * again, and null is returned — so callers fail cleanly instead of sending
     * a dead token that the gateway answers with a cryptic HTTP 401.
     */
    async getAccessToken(): Promise<string | null> {
        let t = await this.readTokens();
        if (!t) { return null; }
        // Still valid — return it, and clear any prior expired notice flag so a
        // future re-expiry can notify again.
        if (Date.now() < t.expiresAtMs - 60_000) {
            this.expiredNoticeShown = false;
            return t.accessToken;
        }
        // Expired: try to refresh transparently.
        if (t.refreshToken) {
            try {
                const disco = await this.discovery();
                const res = await fetch(disco.token_endpoint, {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: this.clientId() }).toString(),
                });
                if (res.ok) {
                    t = this.toStored(await res.json() as { access_token?: string; token_type?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string });
                    await this.writeTokens(t);
                    this.expiredNoticeShown = false;
                    return t.accessToken;
                }
                this.log(`[auth] refresh rejected: HTTP ${res.status}`);
            } catch (err) {
                this.log(`[auth] refresh failed: ${err}`);
            }
        }
        // Cannot recover: clear the dead session and tell the user once.
        await this.clearExpiredSession();
        return null;
    }

    /** Clears tokens + profile and surfaces the "session expired" notice once. */
    private async clearExpiredSession(): Promise<void> {
        await this.context.secrets.delete(SECRET_KEY);
        await this.context.globalState.update(FALLBACK_KEY, undefined);
        const hadProfile = !!this.profileCache;
        this.profileCache = undefined;
        await this.context.globalState.update(PROFILE_KEY, undefined);
        this.onChangeEmitter.fire();
        if (hadProfile && !this.expiredNoticeShown) {
            this.expiredNoticeShown = true;
            void vscode.window
                .showWarningMessage(
                    "Sua sessão do Sufficit expirou e não pôde ser renovada automaticamente.",
                    "Entrar novamente",
                )
                .then((choice) => {
                    if (choice === "Entrar novamente") {
                        void vscode.commands.executeCommand("symposium.login");
                    }
                });
        }
    }

    async getProfile(force = false): Promise<SufficitProfile | undefined> {
        if (this.profileCache && !force) { return this.profileCache; }
        // Instant restore after a window reload: a persisted profile lets the UI
        // show the logged-in account immediately. But only when the access token
        // is still usable — getAccessToken() refreshes on demand, and clears the
        // session (profile included) when the token has expired for good, so we
        // never restore a profile for a session that can no longer authenticate.
        if (!force) {
            const saved = this.context.globalState.get<SufficitProfile>(PROFILE_KEY);
            const token = await this.getAccessToken();
            if (saved && token) {
                this.profileCache = saved;
                void this.getProfile(true).then((p) => { if (p) { this.onChangeEmitter.fire(); } });
                return saved;
            }
            return undefined;
        }
        const token = await this.getAccessToken();
        if (!token) { return undefined; }
        try {
            const disco = await this.discovery();
            const res = await fetch(disco.userinfo_endpoint ?? `${this.issuer()}/connect/userinfo`, { headers: { authorization: `Bearer ${token}` } });
            if (!res.ok) { return this.profileCache; }   // keep what we have on a transient failure
            const j = await res.json() as { sub?: string; name?: string; preferred_username?: string; email?: string; picture?: string };
            // Avatar comes from the Sufficit contact endpoint keyed by the user id.
            const picture = j.sub
                ? `https://endpoints.sufficit.com.br/contact/avatar?contextid=${encodeURIComponent(j.sub)}`
                : j.picture;
            this.profileCache = { sub: j.sub ?? "", name: j.name ?? j.preferred_username, email: j.email, picture };
            await this.context.globalState.update(PROFILE_KEY, this.profileCache);
            return this.profileCache;
        } catch {
            return this.profileCache;
        }
    }

    async logout(): Promise<void> {
        await this.context.secrets.delete(SECRET_KEY);
        await this.context.globalState.update(FALLBACK_KEY, undefined);
        await this.context.globalState.update(PROFILE_KEY, undefined);
        this.profileCache = undefined;
        this.onChangeEmitter.fire();
    }
}
