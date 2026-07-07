export function isBridgeAuthorized(authorizationHeader: string | string[] | undefined, url: URL, token: string): boolean {
    if (authorizationHeader === `Bearer ${token}`) {
        return true;
    }
    // EventSource cannot set headers, so allow query-token auth only for
    // GET /sessions/:id/follow SSE consumers. Every other endpoint, including
    // /vault/resolve, must use Authorization: Bearer.
    return /^\/sessions\/[^/]+\/follow\/?$/.test(url.pathname)
        && url.searchParams.get("token") === token;
}
