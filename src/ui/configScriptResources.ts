/** Resource-import interaction state for the Configuration webview. */
export const configScriptResources = `
    let skillImportProgress = null;
    let skillImportProgressTimer = null;
    function skillImportBusy() { return skillImportProgress && (skillImportProgress.phase === "selecting" || skillImportProgress.phase === "copying"); }
    function skillImportLabel() { return skillImportProgress?.phase === "selecting" ? t("config.skills.import.selecting") : t("config.skills.import.copying", skillImportProgress || {}); }
    function skillImportStatusMarkup() {
        const p = skillImportProgress;
        if (!p) { return ""; }
        const done = p.phase === "done";
        const error = p.phase === "error";
        const text = done ? t("config.skills.import.done", p) : error ? t("config.skills.import.failed") : skillImportLabel();
        return '<div class="resource-operation' + (done ? ' done' : error ? ' error' : '') + '" role="status" aria-live="polite">' + (!done && !error ? '<span class="btn-spinner"></span>' : '') + esc(text) + '</div>';
    }
    function setSkillImportProgress(progress) {
        skillImportProgress = progress;
        if (skillImportProgressTimer) { clearTimeout(skillImportProgressTimer); skillImportProgressTimer = null; }
        if (progress.phase === "done" || progress.phase === "error") {
            skillImportProgressTimer = setTimeout(() => { skillImportProgress = null; render(); }, 5000);
        }
        render();
    }
    function startSkillImport() { setSkillImportProgress({ phase: "selecting" }); vscode.postMessage({ type: "import-skills" }); }
    function applySkillImportProgress(message) {
        if (message?.type !== "skill-import-progress") { return false; }
        if (message.phase === "idle") { skillImportProgress = null; render(); }
        else { setSkillImportProgress(message); }
        return true;
    }
`;
