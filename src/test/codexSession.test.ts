import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexModelCatalog } from "../adapters/codex/models";
import { buildHttpMcpWrapperScript, codexWorkspaceArgs, mcpHttpWrapperPath } from "../adapters/codex/session";

test("HTTP MCP wrapper reads URL and headers from mcp.json at runtime", () => {
    const script = buildHttpMcpWrapperScript("/tmp/mcp.json", "sufficit'quoted");

    assert.ok(script.includes(`const CONFIG_PATH = ${JSON.stringify("/tmp/mcp.json")};`));
    assert.ok(script.includes(`const SERVER_NAME = ${JSON.stringify("sufficit'quoted")};`));
    assert.ok(script.includes("fs.readFileSync(CONFIG_PATH"));
    assert.ok(script.includes("server.headers"));
    assert.equal(script.includes("const URL ="), false);
    assert.equal(script.includes("const HEADERS ="), false);
});

test("HTTP MCP wrapper path encodes server names as a single file name", () => {
    const wrapperPath = mcpHttpWrapperPath("../secrets/sufficit");

    assert.equal(path.dirname(wrapperPath), path.join(os.homedir(), ".symposium"));
    assert.equal(path.basename(wrapperPath), "mcp-http-..%2Fsecrets%2Fsufficit.js");
});

test("Codex workspace args add writable VS Code workspace roots", () => {
    const cwd = path.resolve("/workspace/main");
    const extra = path.resolve("/mnt/sufficit");

    assert.deepEqual(
        codexWorkspaceArgs(cwd, [cwd, extra, extra, "relative"]),
        ["--cd", cwd, "--add-dir", extra],
    );
});

test("Codex model catalog uses CLI metadata without model-name hardcoding", () => {
    const result = parseCodexModelCatalog({
        models: [
            { slug: "hidden-model", display_name: "Hidden", visibility: "hide", priority: 1 },
            { slug: "zeta-agent", display_name: "Zeta Agent", visibility: "list", priority: 20 },
            { slug: "alpha-agent", display_name: "Alpha Agent", visibility: "list", priority: 10 },
        ],
    }, "configured-model");

    assert.deepEqual(result.models, ["configured-model", "alpha-agent", "zeta-agent"]);
    assert.deepEqual(result.labels, {
        "alpha-agent": "Alpha Agent",
        "zeta-agent": "Zeta Agent",
    });
});
