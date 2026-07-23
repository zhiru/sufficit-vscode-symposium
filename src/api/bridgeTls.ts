import { HubClient } from "../sync/hubClient";

/**
 * TLS material for the tailnet's wildcard cert, resolved from the vault. Absent when the
 * hub isn't configured or the secrets aren't there — the bridge then falls back to plain
 * HTTP (fine for loopback/localhost use; a tailnet client needs the real cert since its
 * PWA's service worker requires a secure context).
 */
export async function loadBridgeTlsMaterial(): Promise<{ cert: string; key: string } | undefined> {
    const hub = new HubClient();
    if (!hub.configured()) {
        return undefined;
    }
    const [cert, key] = await Promise.all([
        hub.resolveSecret("tls/headscale-wildcard-fullchain"),
        hub.resolveSecret("tls/headscale-wildcard-privkey"),
    ]);
    return cert && key ? { cert, key } : undefined;
}
