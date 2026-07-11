import * as vscode from "vscode";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";
import { getSttState } from "../voice/sttService";
import { buildSttDiagnostic, SttDiagnosticSnapshot } from "../voice/sttDiagnostic";

export type { DiagnoseResult, DiagnoseStep } from "../voice/sttDiagnostic";

/**
 * Handles the voice-setup diagnostic webview message for a live ConfigPanel.
 * Mirrors the controllerMessageHandler precedent: returns true when handled.
 *
 * Runs the same static probes getSttState uses (binary on PATH + model
 * installed) and posts a structured checklist back so the wizard UI can show
 * step-by-step what's missing and offer fixes (download a model, or copy an
 * install command for a missing binary).
 */
export async function handleVoiceMessage(_message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    if (_message.type !== "stt-diagnose") { return false; }
    const stt = await getSttState().catch(() => null);
    if (!stt) {
        ctx.post({ type: "stt-diagnose-result", result: { ready: false, steps: [] } });
        return true;
    }
    const result = buildSttDiagnostic(
        stt as unknown as SttDiagnosticSnapshot,
        ctx.tr,
        _message.webSpeechSupported,
        vscode.env.uiKind === vscode.UIKind.Web,
    );
    ctx.post({ type: "stt-diagnose-result", result });
    return true;
}
