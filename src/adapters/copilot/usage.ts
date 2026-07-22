import { EmptyAdapterUsage } from "../quotaCache";

/** Account-usage singleton for every GitHub Copilot conversation. */
export const copilotUsage = new EmptyAdapterUsage(
    "copilot",
    "GitHub Copilot",
    "GitHub Copilot usage JSON has not been discovered on this installation yet.",
);
