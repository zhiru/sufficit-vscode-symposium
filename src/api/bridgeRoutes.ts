/** Decodes one URL path segment without letting malformed escapes crash routing. */
export function decodeBridgePathSegment(value: string | undefined): string | undefined {
    if (!value) { return undefined; }
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}
