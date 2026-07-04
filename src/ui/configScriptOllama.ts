/**
 * Symposium config webview client script — model-suggestions fragment.
 *
 * Split out of configScript.ts so that file stays under the 400-line cap.
 * This is a raw JS source string concatenated into the config client script
 * (configScript.ts), so it runs in the same webview scope and shares its
 * esc()/t()/state/vscode.
 *
 * Two suggestion sources feed the shared <datalist>: the Ollama endpoint models
 * (fetch-ollama-models) and — when logged into Sufficit — the Sufficit AI
 * models/presets (fetch-sufficit-presets), which load automatically.
 */
export const configScriptOllama = `
    // Both sources of model suggestions; the datalist is rebuilt from the union.
    var __ollamaModels = [];
    var __sufficitPresets = [];
    var __sufficitEndpoint = "";

    function __rebuildModelsDatalist() {
        var list = document.getElementById("vscode-models-list");
        if (!list) return;
        list.innerHTML = "";
        // Use the friendly NAME as the option value (readable, and the format the
        // GitLens/Copilot fields expect) — never the raw preset UUID, which the
        // native datalist would show as a big unformatted hash and break layout.
        var seen = {};
        function add(value) {
            if (!value || seen[value]) return;
            seen[value] = 1;
            var o = document.createElement("option");
            o.value = value;   // native datalist: value == shown text (no repeated hint line)
            list.appendChild(o);
        }
        // Gateway tag names are used verbatim — GitLens/Copilot send the model id
        // back to the gateway, so it must match /api/tags exactly (no stripping).
        __sufficitPresets.forEach(function (m) { add(m.name || m.id); });
        __ollamaModels.forEach(function (m) { add(m.name || m.id); });
    }

    function __setModelsStatus() {
        var status = document.getElementById("ollama-models-status");
        if (!status) return;
        status.classList.remove("loading");
        var uniq = {};
        __sufficitPresets.concat(__ollamaModels).forEach(function (m) { uniq[m.name || m.id] = 1; });
        var total = Object.keys(uniq).length;
        if (total > 0) {
            status.classList.remove("error"); status.classList.add("ok");
            if (__sufficitPresets.length) {
                status.textContent = t("config.vscode.models.availableSufficit", { count: total, sufficit: __sufficitPresets.length });
            } else {
                status.textContent = t("config.vscode.models.available", { count: total });
            }
        } else {
            status.classList.remove("ok"); status.classList.add("error");
            status.textContent = t("config.vscode.models.none");
        }
    }

    // fetch-ollama-models reply.
    function applyOllamaModels(models) {
        __ollamaModels = (models || []).filter(function (m) { return m && m.id; });
        __rebuildModelsDatalist();
        __setModelsStatus();
    }

    // fetch-sufficit-presets reply (empty when not logged in). endpoint = the
    // VS Code Ollama gateway URL (with token) the model fields must point at.
    function applySufficitPresets(presets, endpoint) {
        __sufficitPresets = (presets || []).filter(function (m) { return m && m.id; });
        __sufficitEndpoint = endpoint || "";
        __rebuildModelsDatalist();
        __setModelsStatus();
        // Proactively point GitLens at the gateway: fill the Ollama URL when empty
        // or still holding a non-gateway URL (e.g. the openai/v1 base). Persists it.
        if (__sufficitEndpoint) {
            var urlInput = document.getElementById("gitlens-ai-ollama-url");
            if (urlInput && urlInput.value !== __sufficitEndpoint &&
                (!urlInput.value || urlInput.value.indexOf("/vscode/") === -1)) {
                urlInput.value = __sufficitEndpoint;
                urlInput.dispatchEvent(new Event("change"));
            }
        }
    }

    function __isSufficitPreset(name) {
        return __sufficitPresets.some(function (m) { return (m.name || m.id) === name; });
    }

    function setOllamaModelsLoading() {
        var status = document.getElementById("ollama-models-status");
        if (status) { status.classList.remove("ok", "error"); status.classList.add("loading"); status.textContent = t("config.vscode.models.loading"); }
    }

    // Query the Ollama endpoint (if a URL is set) and the Sufficit presets (auto,
    // when logged in) so suggestions are ready without any manual step.
    function autoFetchOllamaModels() {
        setOllamaModelsLoading();
        vscode.postMessage({ type: "fetch-sufficit-presets" });
        var urlInput = document.getElementById("gitlens-ai-ollama-url");
        var url = urlInput && urlInput.value;
        // A Sufficit gateway URL (/vscode/{token}) serves the SAME presets via
        // /api/tags, so fetching it again would duplicate the list. Only query a
        // separate (non-gateway) Ollama endpoint.
        if (url && url.indexOf("/vscode/") === -1) { vscode.postMessage({ type: "fetch-ollama-models", value: url }); }
    }

    // "Backend auto-configured": when a Sufficit preset is chosen in a model
    // field and the Ollama URL is still empty, point it at the Sufficit endpoint.
    function __maybeAutoConfigSufficit(inputEl) {
        if (!inputEl || !__sufficitEndpoint) return;
        var isPreset = __sufficitPresets.some(function (m) { return (m.name || m.id) === inputEl.value; });
        if (!isPreset) return;
        var urlInput = document.getElementById("gitlens-ai-ollama-url");
        if (urlInput && !urlInput.value) {
            urlInput.value = __sufficitEndpoint;
            urlInput.dispatchEvent(new Event("change"));
        }
    }
`;
