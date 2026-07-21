import * as vscode from "vscode";
import type { ConfigHandlerCtx, ConfigMessage } from "./configPanel";
import { getSttState, readSettings } from "../voice/sttService";
import { buildSttDiagnostic, SttDiagnosticSnapshot } from "../voice/sttDiagnostic";
import { buildSttRecoveryPrompt, getSttRecoveryTarget } from "../voice/sttRecovery";
import { defaultCwd } from "../extension/config";

export type { DiagnoseResult, DiagnoseStep } from "../voice/sttDiagnostic";

/**
 * Handles the voice-setup diagnostic webview messages for a live ConfigPanel.
 * Mirrors the controllerMessageHandler precedent: returns true when handled.
 */
export async function handleVoiceMessage(_message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    if (_message.type === "stt-diagnose") { return handleManualDiagnose(_message, ctx); }
    if (_message.type === "stt-sufficit-diagnose") { return handleSufficitDiagnose(ctx); }
    if (_message.type === "stt-sufficit-recover") { return handleSufficitRecover(ctx); }
    return false;
}

/**
 * Runs the same static probes getSttState uses (binary on PATH + model
 * installed) and posts a structured checklist back so the wizard UI can show
 * step-by-step what's missing and offer fixes (download a model, or copy an
 * install command for a missing binary).
 */
async function handleManualDiagnose(message: ConfigMessage, ctx: ConfigHandlerCtx): Promise<boolean> {
    const stt = await getSttState().catch(() => null);
    if (!stt) {
        ctx.post({ type: "stt-diagnose-result", result: { ready: false, steps: [] } });
        return true;
    }
    const result = buildSttDiagnostic(
        stt as unknown as SttDiagnosticSnapshot,
        ctx.tr,
        message.webSpeechSupported,
        vscode.env.uiKind === vscode.UIKind.Web,
    );
    ctx.post({ type: "stt-diagnose-result", result });
    return true;
}

/**
 * The autonomous counterpart: instead of a deterministic checklist, hands the
 * whole "figure out which local STT engine actually works best here" problem
 * to a real Sufficit AI agent session — install every engine, download
 * models, benchmark each, and decide. Requires the user to be signed in AND
 * the Sufficit AI backend to be usable (see SUFFICIT_DIAGNOSE_UNAVAILABLE
 * below for what "usable" checks).
 */
async function handleSufficitDiagnose(ctx: ConfigHandlerCtx): Promise<boolean> {
    const loggedIn = (await ctx.auth?.isLoggedIn().catch(() => false)) === true;
    const backends = await ctx.api.backends.list().catch(() => []);
    const openaiAvailable = backends.some((b) => b.backend === "openai" && b.available);
    if (!loggedIn || !openaiAvailable || !ctx.chatView) {
        ctx.post({ type: "stt-sufficit-diagnose-result", ok: false });
        return true;
    }
    const cwd = defaultCwd();
    const key = await ctx.api.sessions.create("openai", { cwd });
    if (!key) {
        ctx.post({ type: "stt-sufficit-diagnose-result", ok: false });
        return true;
    }
    ctx.api.sessions.send(key, SUFFICIT_VOICE_BENCHMARK_PROMPT, "send");
    void ctx.chatView.openDialogue("openai", { cwd, resumeSessionId: key }, "Voice engine benchmark");
    ctx.post({ type: "stt-sufficit-diagnose-result", ok: true });
    return true;
}

/** Restores only the already-selected local winner; never benchmarks again. */
async function handleSufficitRecover(ctx: ConfigHandlerCtx): Promise<boolean> {
    const settings = readSettings();
    const target = getSttRecoveryTarget(settings);
    const prompt = buildSttRecoveryPrompt(settings);
    if (!target || !prompt) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "no-winner" });
        return true;
    }
    const loggedIn = (await ctx.auth?.isLoggedIn().catch(() => false)) === true;
    const backends = await ctx.api.backends.list().catch(() => []);
    const openaiAvailable = backends.some((b) => b.backend === "openai" && b.available);
    if (!loggedIn || !openaiAvailable || !ctx.chatView) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "unavailable" });
        return true;
    }
    const cwd = defaultCwd();
    const key = await ctx.api.sessions.create("openai", { cwd });
    if (!key) {
        ctx.post({ type: "stt-sufficit-recover-result", ok: false, reason: "unavailable" });
        return true;
    }
    ctx.api.sessions.send(key, prompt, "send");
    void ctx.chatView.openDialogue("openai", { cwd, resumeSessionId: key }, `Voice engine recovery: ${target.engine}`);
    ctx.post({ type: "stt-sufficit-recover-result", ok: true, engine: target.engine, model: target.model });
    return true;
}

const SUFFICIT_VOICE_BENCHMARK_PROMPT =
    "Você está numa sessão autônoma, sem ninguém observando — não espere confirmação nem pergunte nada, decida e execute até o fim, depois pare.\n\n" +
    "TAREFA: neste projeto (extensão VS Code \"Symposium\"), decida qual dos 3 engines locais de reconhecimento de voz (speech-to-text) instalar e configurar como padrão.\n\n" +
    "Contexto: Symposium suporta 3 engines locais além do Web Speech (que só funciona em navegador de verdade, não no VS Code desktop): " +
    "whisper.cpp (binário whisper-cli), faster-whisper (binário whisper-ctranslate2) e vosk (binário vosk-transcriber). " +
    "As configurações ficam em symposium.voice.* no settings.json do VS Code. O código-fonte relevante está em src/voice/ deste repo " +
    "(sttCatalog.ts tem os IDs/URLs dos modelos, sttEngines.ts mostra como cada engine é invocado por linha de comando, sttService.ts lê as configurações).\n\n" +
    "Passos:\n" +
    "1. Garanta os 3 binários instalados: whisper.cpp via apt (sudo apt-get install -y whisper.cpp), faster-whisper e vosk via pipx " +
    "(pipx install whisper-ctranslate2 / pipx install vosk — NÃO use pip direto, este sistema tem PEP 668 externally-managed-environment; instale pipx via apt se preciso).\n" +
    "2. Baixe um modelo pequeno/rápido em português (ou multilíngue) para cada engine (veja sttCatalog.ts para os IDs e URLs exatos).\n" +
    "3. Sintetize uma frase de teste de exatamente ~10 palavras em português como áudio: instale espeak-ng (ou festival) via apt se necessário, " +
    "gere um WAV de 16kHz mono (formato que os 3 engines esperam).\n" +
    "4. Para cada engine, rode a transcrição dessa mesma frase 3 vezes e meça o tempo de parede (wall-clock) de cada execução; use a média.\n" +
    "5. Alvo: transcrever uma frase de 10 palavras em no máximo 4 segundos. Decida qual engine tem o melhor custo/benefício " +
    "(velocidade vs. corretude da transcrição vs. tamanho do modelo baixado) — não precisa ser o mais rápido se a transcrição sair claramente errada.\n" +
    "6. Aplique sua decisão: edite diretamente o settings.json do usuário do VS Code " +
    "(normalmente ~/.config/Code/User/settings.json no Linux) definindo symposium.voice.engine para o engine escolhido " +
    "e o campo de modelo correspondente (symposium.voice.whisper.model / symposium.voice.fasterWhisper.model / symposium.voice.vosk.model). " +
    "Preserve todo o resto do arquivo — leia antes de escrever, edite só essas chaves.\n" +
    "7. Termine com um resumo claro em português: tabela com engine, tempo médio, tamanho do modelo, resultado (ok/errado) e a decisão final com o motivo.\n\n" +
    "Rastreamento: use add_task para registrar os 7 passos acima como tarefas (no Tasks panel), e chame task_complete(id) em cada uma " +
    "IMEDIATAMENTE ao terminá-la — não deixe pra marcar só a última no final. Um memory_save de checkpoint documentando o progresso é " +
    "ÚTIL mas NÃO substitui o task_complete: são coisas diferentes, faça as duas (checkpoint pra contexto, task_complete pra fechar a tarefa).";
