import * as os from "node:os";
import * as path from "node:path";
import { JsonlAdapterUsage } from "../quotaCache";

/** Account-usage singleton for every Codex conversation. */
export const codexUsage = new JsonlAdapterUsage("codex", "Codex", () => [
    path.join(os.homedir(), ".codex", "sessions"),
    path.join(os.homedir(), ".codex", "archived_sessions"),
]);
