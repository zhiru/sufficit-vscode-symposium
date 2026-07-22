/**
 * Bridge to the VS Code Speech provider already installed in the desktop UI.
 *
 * VS Code does not expose a consumer API for `ISpeechService` to extensions.
 * It does expose the built-in editor dictation commands, however. Those commands
 * run in the workbench/UI process and use the same `ISpeechService` path as
 * Copilot Chat: `ms-vscode.vscode-speech` provides the local recognizer.
 *
 * The bridge gives that command a disposable text document, reads the dictated
 * text from it, then reverts/closes the document. It deliberately fails closed:
 * unavailable commands/providers or a session with no transcript simply leave
 * the Symposium mic unavailable / return no text; no model or native runtime is
 * bundled, copied, or downloaded by Symposium.
 */
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

const START_DICTATION_COMMAND = "workbench.action.editorDictation.start";
const STOP_DICTATION_COMMAND = "workbench.action.editorDictation.stop";
const REVERT_AND_CLOSE_COMMAND = "workbench.action.revertAndCloseActiveEditor";
const STOP_SETTLE_MS = 180;

let storageDir = "";

interface DictationSession {
    document: vscode.TextDocument;
    filePath: string;
    originalEditor: vscode.TextEditor | undefined;
}

let activeSession: DictationSession | undefined;

export function initVscodeSpeechBridge(globalStoragePath: string): void {
    storageDir = path.join(globalStoragePath, "vscode-speech-bridge");
}

/** Whether the desktop UI has the Microsoft provider available to its workbench. */
export function isVscodeSpeechAvailable(): boolean {
    // `editorDictation.start` has the workbench's `hasSpeechProvider`
    // precondition. The command is our runtime probe: presence of the
    // extension alone is insufficient because it might be disabled, unsupported
    // by the current VS Code distribution, or have no language model installed.
    return vscode.env.uiKind !== vscode.UIKind.Web;
}

/** Start VS Code editor dictation in an isolated, disposable document. */
export async function startVscodeSpeechDictation(): Promise<void> {
    if (!isVscodeSpeechAvailable()) {
        throw new Error("VS Code Speech is not installed in this VS Code UI.");
    }
    if (activeSession) {
        throw new Error("VS Code Speech dictation is already in progress.");
    }
    if (!storageDir) {
        throw new Error("VS Code Speech bridge has not been initialized.");
    }

    await fs.mkdir(storageDir, { recursive: true });
    const filePath = path.join(storageDir, `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await fs.writeFile(filePath, "", "utf8");

    const originalEditor = vscode.window.activeTextEditor;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    activeSession = { document, filePath, originalEditor };

    try {
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
        await vscode.commands.executeCommand(START_DICTATION_COMMAND);
    } catch (error) {
        await cleanupSession();
        throw error;
    }
}

/** Stop dictation and return the final transcript written by VS Code. */
export async function stopVscodeSpeechDictation(): Promise<string> {
    const session = activeSession;
    if (!session) {
        throw new Error("VS Code Speech dictation is not in progress.");
    }

    try {
        // Editor actions target the active editor. Restore the bridge document
        // because the user normally returned focus to the Symposium webview.
        await vscode.window.showTextDocument(session.document, { preview: true, preserveFocus: false });
        await vscode.commands.executeCommand(STOP_DICTATION_COMMAND);
        await delay(STOP_SETTLE_MS);
        return session.document.getText().trim();
    } finally {
        await cleanupSession();
    }
}

/** Cancel any in-flight dictation session without returning its provisional text. */
export async function cancelVscodeSpeechDictation(): Promise<void> {
    if (!activeSession) { return; }
    try {
        await vscode.window.showTextDocument(activeSession.document, { preview: true, preserveFocus: false });
        await vscode.commands.executeCommand(STOP_DICTATION_COMMAND);
    } catch {
        // The command is best-effort: cleanup below is still required.
    } finally {
        await cleanupSession();
    }
}

async function cleanupSession(): Promise<void> {
    const session = activeSession;
    activeSession = undefined;
    if (!session) { return; }

    try {
        await vscode.commands.executeCommand(REVERT_AND_CLOSE_COMMAND);
    } catch {
        // Closing is cosmetic; the temporary file is always removed below.
    }

    if (session.originalEditor) {
        try {
            await vscode.window.showTextDocument(session.originalEditor.document, {
                viewColumn: session.originalEditor.viewColumn,
                preserveFocus: true,
                selection: session.originalEditor.selection,
            });
        } catch {
            // The original editor may have been closed while dictating.
        }
    }

    await fs.unlink(session.filePath).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
