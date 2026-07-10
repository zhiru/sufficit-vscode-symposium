import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("ESLint treats async functions without await as errors", () => {
    const configPath = path.resolve(__dirname, "..", "..", "eslint.config.mjs");
    const config = fs.readFileSync(configPath, "utf8");

    assert.match(config, /"@typescript-eslint\/require-await"\s*:\s*"error"/);
});
