/**
 * Symposium config webview client script — STT host-message handling fragment.
 *
 * Split out of configScript.ts so that file stays under the 400-line cap.
 * Handles the two host→webview STT messages (download progress + the setup
 * diagnostic result) as a single dispatched function. Raw JS source string
 * concatenated into the config client script; runs in the same webview scope
 * and shares esc()/t()/vscode.
 */
export const configScriptStt = `
    function bindVscodeSpeechInstall(root) {
        (root || document).querySelectorAll("button.stt-install-vscode-speech").forEach((button) => {
            button.onclick = () => {
                button.disabled = true;
                button.textContent = t("config.voice.vscodeSpeech.installing");
                vscode.postMessage({ type: "stt-install-vscode-speech" });
            };
        });
    }

    // Returns true when the host message was an STT one (so the caller can stop).
    function applySttHostMessage(d) {
        if (d.type === "stt-progress") {
            const bar = document.getElementById("stt-prog-" + d.modelId);
            if (bar) {
                const ratio = typeof d.ratio === "number" ? d.ratio : -1;
                if (d.phase === "done") { bar.textContent = ""; }
                else if (ratio >= 0) { bar.textContent = Math.round(ratio * 100) + "%"; }
                else { bar.textContent = t("config.voice.downloading"); }
            }
            return true;
        }
        if (d.type === "stt-diagnose-result") {
            const out = document.getElementById("stt-diag-result");
            if (out) {
                const r = d.result || { ready: false, steps: [] };
                const steps = r.steps || [];
                if (!steps.length) {
                    out.innerHTML = '<div class="desc">' + esc(t("config.voice.diagnose.unavailable")) + '</div>';
                } else {
                    const row = (st) => {
                        const icon = st.status === "ok" ? "✓" : "✗";
                        let body = '<div class="row"><span class="name" style="color:var(--sym-' + (st.status === "ok" ? "ok" : "bad") + ')">' + icon + '</span>' +
                            '<span class="desc">' + esc(st.label) + '</span></div>';
                        if (st.status !== "ok") {
                            if (st.fix) { body += '<div class="desc" style="margin:0 0 8px 22px;font-family:var(--vscode-editor-font-family)">' + esc(st.fix) + '</div>'; }
                            if (st.downloadable && st.downloadable.length) {
                                body += '<div style="margin:0 0 8px 22px" class="preset-actions">' +
                                    st.downloadable.map((id) => '<button class="secondary stt-download" data-model="' + esc(id) + '">' + esc(t("config.voice.diagnose.download") + " " + id) + '</button>').join("") +
                                    '</div>';
                            }
                            if (st.action === "install-vscode-speech") {
                                body += '<div style="margin:0 0 8px 22px" class="preset-actions">' +
                                    '<button class="secondary stt-install-vscode-speech">' + esc(st.actionLabel || t("config.voice.vscodeSpeech.install")) + '</button>' +
                                    '</div>';
                            }
                        }
                        return body;
                    };
                    const head = r.ready
                        ? '<div class="desc" style="color:var(--sym-ok);margin-bottom:8px">' + esc(t("config.voice.diagnose.allOk")) + '</div>'
                        : '<div class="desc" style="color:var(--sym-bad);margin-bottom:8px">' + esc(t("config.voice.diagnose.notReady")) + '</div>';
                    out.innerHTML = head + steps.map(row).join("");
                    // (Re)bind the download buttons the wizard may have injected.
                    out.querySelectorAll("button.stt-download").forEach((el) => {
                        el.onclick = () => {
                            const id = el.getAttribute("data-model");
                            el.textContent = t("config.voice.downloading");
                            el.disabled = true;
                            vscode.postMessage({ type: "stt-download-model", modelId: id });
                        };
                    });
                    bindVscodeSpeechInstall(out);
                }
            }
            return true;
        }
        if (d.type === "stt-vscode-speech-install-result") {
            const out = document.getElementById("stt-diag-result");
            if (out) {
                if (d.ok) {
                    out.innerHTML = '<div class="desc" style="color:var(--sym-ok)">' + esc(t("config.voice.vscodeSpeech.installed")) + '</div>';
                } else {
                    out.innerHTML = '<div class="desc" style="color:var(--sym-bad);margin-bottom:8px">' +
                        esc(t("config.voice.vscodeSpeech.installFailed", { error: d.error || "unknown error" })) + '</div>' +
                        '<button class="secondary stt-install-vscode-speech">' + esc(t("config.voice.vscodeSpeech.install")) + '</button>';
                    bindVscodeSpeechInstall(out);
                }
            }
            return true;
        }
        if (d.type === "stt-sufficit-diagnose-result") {
            const out = document.getElementById("stt-sufficit-diag-result");
            const btn = document.getElementById("stt-sufficit-diagnose");
            if (btn) { btn.disabled = false; }
            if (out) {
                out.innerHTML = d.ok
                    ? '<div class="desc" style="color:var(--sym-ok)">' + esc(t("config.voice.sufficitDiagnose.started")) + '</div>'
                    : '<div class="desc" style="color:var(--sym-bad)">' + esc(t("config.voice.sufficitDiagnose.failed")) + '</div>';
            }
            return true;
        }
        if (d.type === "stt-sufficit-recover-result") {
            const out = document.getElementById("stt-sufficit-recover-result");
            const btn = document.getElementById("stt-sufficit-recover");
            if (btn) { btn.disabled = false; }
            if (out) {
                const key = d.ok
                    ? "config.voice.sufficitRecover.started"
                    : (d.reason === "no-winner" ? "config.voice.sufficitRecover.noWinner" : "config.voice.sufficitRecover.failed");
                out.innerHTML = '<div class="desc" style="color:var(--sym-' + (d.ok ? "ok" : "bad") + ')">' + esc(t(key)) + '</div>';
            }
            return true;
        }
        return false;
    }
`;
