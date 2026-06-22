// The single webview↔extension messaging handle. acquireVsCodeApi() may only be
// called once per webview, so it lives here and every module imports it.
export const vscode = acquireVsCodeApi();

// Persisted webview UI state (send mode, pane width, collapsed groups, …).
export const saved: any = (vscode.getState && (vscode.getState() as any)) || {};
export function saveState(patch: any) {
    if (vscode.setState) { vscode.setState(Object.assign({}, saved, patch)); }
    Object.assign(saved, patch);
}
