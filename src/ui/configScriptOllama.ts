/**
 * Symposium config webview client script — Ollama models fragment.
 *
 * Split out of configScript.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configScript.ts), so it runs in the same webview scope and shares its
 * esc()/t()/state/vscode.
 */
export const configScriptOllama = `
    function applyOllamaModels(models) {
        const select = document.getElementById("ollama-models-select");
        if (!select) return;
        select.innerHTML = '<option value="">Selecione um modelo...</option>';
        (models || []).forEach((m) => {
            const option = document.createElement("option");
            option.value = m.id;
            option.textContent = m.name + " (" + (m.digest ? m.digest.substring(0, 12) : "") + ")";
            select.appendChild(option);
        });
        select.style.display = "block";
        // Handler para quando um modelo é selecionado
        select.onchange = () => {
            const selected = select.value;
            if (selected) {
                // Preencher o campo de modelo selecionado
                const modelInput = document.querySelector('input[data-key="gitlens.ai.ollama.model"]');
                if (modelInput) {
                    modelInput.value = selected;
                    modelInput.dispatchEvent(new Event("change"));
                }
            }
        };
    }
`;
