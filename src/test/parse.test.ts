import { test } from "node:test";
import assert from "node:assert/strict";
import {
    summarizeToolInput, contextWindowFor, toolFilePath, lineCount,
    diffCounts, editDiff, prettyJson, toolResultText,
} from "../adapters/parse";

test("summarizeToolInput: file path → last two segments", () => {
    assert.equal(summarizeToolInput({ file_path: "/a/b/c/d.ts" }), "c/d.ts");
});

test("summarizeToolInput: Read with offset/limit → range", () => {
    assert.equal(summarizeToolInput({ file_path: "/x/y.ts", offset: 10, limit: 5 }), "x/y.ts:10-15");
});

test("summarizeToolInput: command collapses whitespace", () => {
    assert.equal(summarizeToolInput({ command: "ls   -la\n  ." }), "ls -la .");
});

test("summarizeToolInput: grep pattern (no path) is quoted", () => {
    assert.equal(summarizeToolInput({ pattern: "foo" }), '"foo"');
});

test("summarizeToolInput: caps at 160 chars", () => {
    const out = summarizeToolInput({ command: "x".repeat(300) });
    assert.ok(out.length <= 160 && out.endsWith("..."));
});

test("contextWindowFor: default 200k, 1m variants", () => {
    assert.equal(contextWindowFor("opus"), 200000);
    assert.equal(contextWindowFor("sonnet[1m]"), 1000000);
    assert.equal(contextWindowFor("claude-1m"), 1000000);
});

test("toolFilePath: file_path/notebook_path or undefined", () => {
    assert.equal(toolFilePath({ file_path: "/a.ts" }), "/a.ts");
    assert.equal(toolFilePath({ notebook_path: "/n.ipynb" }), "/n.ipynb");
    assert.equal(toolFilePath({ command: "ls" }), undefined);
});

test("lineCount", () => {
    assert.equal(lineCount("a\nb\nc"), 3);
    assert.equal(lineCount(""), 0);
    assert.equal(lineCount(123), 0);
});

test("diffCounts: Edit / Write / MultiEdit", () => {
    assert.deepEqual(diffCounts("Edit", { old_string: "a\nb", new_string: "a\nb\nc" }), { added: 3, removed: 2 });
    assert.deepEqual(diffCounts("Write", { content: "x\ny" }), { added: 2, removed: 0 });
    assert.deepEqual(
        diffCounts("MultiEdit", { edits: [{ old_string: "a", new_string: "a\nb" }, { old_string: "c\nd", new_string: "c" }] }),
        { added: 3, removed: 3 },
    );
    assert.equal(diffCounts("Read", {}), undefined);
});

test("editDiff: hunks per tool", () => {
    assert.deepEqual(editDiff("Edit", { old_string: "x", new_string: "y" }), [{ old: "x", new: "y" }]);
    assert.deepEqual(editDiff("Write", { content: "z" }), [{ old: "", new: "z" }]);
    assert.equal(editDiff("Read", {}), undefined);
});

test("prettyJson truncates huge input", () => {
    const out = prettyJson({ big: "y".repeat(7000) });
    assert.ok(out.includes("truncated"));
});

test("toolResultText: string, blocks, object", () => {
    assert.equal(toolResultText("hi"), "hi");
    assert.equal(toolResultText([{ text: "a" }, { text: "b" }]), "ab");
    assert.equal(toolResultText({ k: 1 }), '{"k":1}');
});
