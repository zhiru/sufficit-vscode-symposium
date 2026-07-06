import * as vscode from "vscode";
import { SufficitAuth } from "../auth/identity";
import { symposiumLog } from "../extension/log";
import { commitDiff, recentSubjects } from "../git";
import { resolveVSCodeGateway, GatewayPreset } from "../ui/vscodeGateway";

/**
 * Native "Generate Commit Message" for the Source Control input box.
 *
 * VS Code's built-in ✨ (github.copilot.git.generateCommitMessage) is hardwired
 * to Copilot's `copilot-utility-small` endpoint and hangs when there is no
 * Copilot session — it never reaches Sufficit. This command sits in the SAME
 * scm/inputBox toolbar and talks straight to the Sufficit AI Ollama gateway
 * (`<origin>/vscode/{token}` → POST /api/chat), so it works with just a
 * Sufficit login, on desktop and code-server alike.
 */

const DEFAULT_ORIGIN = "https://ai.sufficit.com.br";
const DIFF_BUDGET = 12000;   // chars of diff sent to the model

interface GitRepo {
    rootUri: vscode.Uri;
    inputBox: { value: string };
}
interface GitApi { repositories: GitRepo[]; }

export function registerCommitMessage(context: vscode.ExtensionContext, auth: SufficitAuth): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("symposium.generateCommitMessage", (arg?: unknown) =>
            run(context, auth, arg)),
    );
}

async function run(context: vscode.ExtensionContext, auth: SufficitAuth, arg?: unknown): Promise<void> {
    try {
        const repo = resolveRepo(arg);
        symposiumLog(`[commit] invoked; repo=${repo?.rootUri.fsPath ?? "<none>"}`);
        if (!repo) {
            void vscode.window.showErrorMessage("Sufficit: no Git repository found for the commit message.");
            return;
        }

        const loginToken = (await auth.getAccessToken()) ?? "";
        if (!loginToken) {
            symposiumLog("[commit] aborted: not logged in (no access token)");
            void vscode.window.showWarningMessage("Sufficit: sign in first (Sufficit AI login) to generate commit messages.");
            return;
        }

        const cfg = vscode.workspace.getConfiguration("symposium.commit");
        let origin = (cfg.get<string>("origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
        if (!/^https?:\/\//.test(origin)) { origin = DEFAULT_ORIGIN; }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: "Sufficit: generating commit message…" },
            async () => {
                const diff = (await commitDiff(repo.rootUri.fsPath)).trim();
                symposiumLog(`[commit] diff length=${diff.length}`);
                if (!diff) {
                    void vscode.window.showInformationMessage("Sufficit: no changes to describe.");
                    return;
                }

                const gw = await resolveVSCodeGateway(context, origin, loginToken);
                symposiumLog(`[commit] gateway=${gw ? gw.gatewayUrl.replace(/\/[^/]+$/, "/***") : "<null>"} presets=${gw?.presets.length ?? 0}`);
                if (!gw) {
                    void vscode.window.showErrorMessage("Sufficit: could not reach the AI gateway (check login / network).");
                    return;
                }

                const model = pickModel(cfg.get<string>("model") || "", gw.presets);
                symposiumLog(`[commit] model=${model || "<none>"}`);
                if (!model) {
                    void vscode.window.showErrorMessage("Sufficit: no AI model available for commit generation.");
                    return;
                }

                const recent = await recentSubjects(repo.rootUri.fsPath, 5);
                const message = await requestMessage(gw.gatewayUrl, model, diff, recent);
                symposiumLog(`[commit] response length=${message.length}`);
                if (!message) {
                    void vscode.window.showErrorMessage("Sufficit: the AI returned no commit message.");
                    return;
                }
                repo.inputBox.value = message;
                symposiumLog("[commit] message written to SCM input box");
            },
        );
    } catch (e) {
        symposiumLog(`[commit] ERROR: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        void vscode.window.showErrorMessage(`Sufficit commit message failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** Resolves the Git repository from the scm/inputBox arg, else the first repo. */
function resolveRepo(arg: unknown): GitRepo | undefined {
    const api = gitApi();
    if (!api) { return undefined; }
    const rootUri = (arg as { rootUri?: vscode.Uri })?.rootUri;
    if (rootUri) {
        const match = api.repositories.find((r) => r.rootUri.fsPath === rootUri.fsPath);
        if (match) { return match; }
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
        const owning = api.repositories
            .filter((r) => active.startsWith(r.rootUri.fsPath))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
        if (owning) { return owning; }
    }
    return api.repositories[0];
}

function gitApi(): GitApi | undefined {
    const ext = vscode.extensions.getExtension<{ getAPI(v: number): GitApi }>("vscode.git");
    try { return ext?.isActive ? ext.exports.getAPI(1) : ext?.exports?.getAPI(1); }
    catch { return undefined; }
}

/** Prefer the configured model name, else a "VS Code" preset, else the first. */
function pickModel(configured: string, presets: GatewayPreset[]): string {
    const name = configured.trim();
    if (name && presets.some((p) => p.name === name)) { return name; }
    if (name && presets.length === 0) { return name; }   // trust config when tags empty
    const vscodePreset = presets.find((p) => /vs\s*code/i.test(p.name));
    return (vscodePreset ?? presets[0])?.name ?? name;
}

async function requestMessage(
    gatewayUrl: string, model: string, diff: string, recent: string[],
): Promise<string> {
    const clipped = diff.length > DIFF_BUDGET
        ? diff.slice(0, DIFF_BUDGET) + "\n…(diff truncated)…"
        : diff;
    const system =
        "You write concise Git commit messages. Output ONLY the message, no quotes, no code fences, " +
        "no preamble. Use the Conventional Commits style: a short imperative subject line (<=72 chars), " +
        "then an optional blank line and a brief body describing what changed and why.";
    const context = recent.length ? `Recent commit subjects for style:\n${recent.join("\n")}\n\n` : "";
    const user = `${context}Generate a commit message for this staged diff:\n\n${clipped}`;

    try {
        const res = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                model,
                stream: false,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                options: { temperature: 0.2 },
            }),
        });
        symposiumLog(`[commit] POST /api/chat model=${model} -> HTTP ${res.status}`);
        if (!res.ok) {
            symposiumLog(`[commit] gateway error body: ${(await res.text()).slice(0, 300)}`);
            return "";
        }
        const d = await res.json() as { message?: { content?: string } };
        return cleanup(d.message?.content ?? "");
    } catch (e) {
        symposiumLog(`[commit] /api/chat fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        return "";
    }
}

/** Strips wrapping code fences / quotes the model may add. */
function cleanup(raw: string): string {
    let s = raw.trim();
    const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
    if (fence) { s = fence[1].trim(); }
    if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) { s = s.slice(1, -1).trim(); }
    return s;
}
