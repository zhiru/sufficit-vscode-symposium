import { test } from "node:test";
import assert from "node:assert/strict";
import { isSufficitNativeMcpIdentity, SUFFICIT_NATIVE_MCP_ID } from "../config/mcpIdentity";

test("Sufficit native MCP identity collapses Claude and Codex name variants", () => {
    assert.equal(SUFFICIT_NATIVE_MCP_ID, "sufficit-ai");
    for (const name of ["Sufficit AI", "sufficit_ai", "sufficit-ai", "SUFFICITAI"]) {
        assert.equal(isSufficitNativeMcpIdentity(name), true);
    }
    assert.equal(isSufficitNativeMcpIdentity("sufficit-memory"), false);
    assert.equal(isSufficitNativeMcpIdentity(undefined), false);
});
