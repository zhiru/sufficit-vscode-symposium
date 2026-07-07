/**
 * Optional Sufficit login access-token provider. When set (at activation) and an
 * adapter has no explicit apiKey/Authorization, the logged-in token is used as
 * the Bearer — so the native "Sufficit AI" backend works right after login with
 * no manual config.
 */
export type OpenAITokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

let openaiTokenProvider: OpenAITokenProvider | undefined;

export function setOpenAITokenProvider(fn: OpenAITokenProvider): void {
    openaiTokenProvider = fn;
}

export function getOpenAITokenProvider(): OpenAITokenProvider | undefined {
    return openaiTokenProvider;
}
