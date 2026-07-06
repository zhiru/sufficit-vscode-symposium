import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { buildHttpMcpWrapperScript, mcpHttpWrapperPath } from "../adapters/codex/session";

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
