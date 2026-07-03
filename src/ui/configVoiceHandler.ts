import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";
import { getSttState, resolveLocalEngine } from "../voice/sttService";

/**
 * One step of the voice setup diagnostic. The webview renders these as a
 * checklist with a status icon, a label, and (when not ok) a fix hint.
 */
export interface DiagnoseStep {
    /** Stable id the webview can key off (ffmpeg | binary | model). */
    id: string;
    /** Localized, human-readable status: "ok" or a short "what's wrong" line. */
    status: "ok" | "fail";
    /** Localized label of what was checked. */
    label: string;
    /** Localized corrective hint shown when status === "fail" (command to run, etc). */
    fix?: string;
    /** For the model step: the model ids that can be downloaded to satisfy it. */
    downloadable?: string[];
}

/** Result posted back to the webview as { type: "stt-diagnose-result", result }. */
export interface DiagnoseResult {
    /** Overall readiness — mirrors isLocalSttReady (all steps ok). */
    ready: boolean;
    steps: DiagnoseStep[];
}

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
    const avail = (stt as { availability?: Record<string, boolean> }).availability || {};
    const settings = (stt as { settings: { whisper?: { binaryPath?: string }; fasterWhisper?: { binaryPath?: string }; vosk?: { binaryPath?: string } } }).settings;
    const models = (stt as { models?: { id: string; engine: string; installed: boolean }[] }).models || [];
    const engine = resolveLocalEngine(settings as Parameters<typeof resolveLocalEngine>[0]);

    const steps: DiagnoseStep[] = [];

    // 1) ffmpeg — required by every local path (capture → 16 kHz mono WAV).
    steps.push({
        id: "ffmpeg",
        status: avail.ffmpeg ? "ok" : "fail",
        label: ctx.tr("config.voice.diagnose.ffmpeg"),
        fix: avail.ffmpeg ? undefined : ctx.tr("config.voice.diagnose.fixFfmpeg"),
    });

    // 2) engine binary.
    const engineAvailKey = engine; // availability keys match engine ids (whisper-cpp / faster-whisper / vosk)
    const binaryOk = !!avail[engineAvailKey];
    const binaryPath =
        engine === "whisper-cpp" ? settings?.whisper?.binaryPath
        : engine === "faster-whisper" ? settings?.fasterWhisper?.binaryPath
        : settings?.vosk?.binaryPath;
    steps.push({
        id: "binary",
        status: binaryOk ? "ok" : "fail",
        label: ctx.tr("config.voice.diagnose.binary", { engine }),
        fix: binaryOk ? undefined : ctx.tr("config.voice.diagnose.fixBinary", {
            engine,
            path: binaryPath || engine,
        }),
    });

    // 3) model — faster-whisper fetches its own on first use, so it's satisfied
    // by the binary alone; whisper-cpp/vosk need a managed model file installed.
    let modelOk = engine === "faster-whisper";
    let downloadable: string[] | undefined;
    if (!modelOk) {
        const forEngine = models.filter((m) => m.engine === engine);
        modelOk = forEngine.some((m) => m.installed);
        if (!modelOk) { downloadable = forEngine.map((m) => m.id); }
    }
    steps.push({
        id: "model",
        status: modelOk ? "ok" : "fail",
        label: ctx.tr("config.voice.diagnose.model", { engine }),
        fix: modelOk ? undefined : ctx.tr("config.voice.diagnose.fixModel"),
        downloadable,
    });

    const ready = steps.every((s) => s.status === "ok");
    ctx.post({ type: "stt-diagnose-result", result: { ready, steps } });
    return true;
}
