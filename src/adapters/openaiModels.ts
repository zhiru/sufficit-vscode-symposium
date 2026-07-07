export function buildOpenAIModelList(configured: string[], pinnedModel?: string): string[] {
    // Do not invent generic OpenAI models for a gateway whose catalog has not
    // loaded yet. Until discovery/config provides real ids, keep the picker
    // empty (or only the explicitly pinned model) so the UI doesn't mislabel a
    // custom backend like Sufficit AI as gpt-4o/gpt-4o-mini.
    if (!configured.length) {
        return pinnedModel ? [pinnedModel] : [];
    }
    return [...new Set([pinnedModel || configured[0], ...configured])];
}
