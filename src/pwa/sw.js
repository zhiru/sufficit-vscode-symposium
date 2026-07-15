/* Symposium PWA service worker — caches the app shell only.
 * NEVER intercepts the API or the SSE /follow stream: those must hit the network
 * with the Bearer header and stay live. */
const SHELL = "sym-pwa-v1";
const SHELL_ASSETS = ["/pwa/", "/pwa/app.js", "/pwa/webview.css", "/pwa/manifest.webmanifest"];

self.addEventListener("install", (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS).catch(() => {})));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    // Only ever handle the shell namespace; let every data/stream request pass
    // straight through to the network untouched.
    if (!url.pathname.startsWith("/pwa/") || url.pathname === "/pwa/app.js.map") { return; }
    e.respondWith(
        fetch(e.request)
            .then((r) => {
                const copy = r.clone();
                caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
                return r;
            })
            .catch(() => caches.match(e.request).then((m) => m || caches.match("/pwa/"))),
    );
});

