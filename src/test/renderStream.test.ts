import assert from "node:assert/strict";
import test from "node:test";
import { RenderStream } from "../ui/renderStream";

test("RenderStream keeps editor and sidebar sinks synchronized", () => {
    const stream = new RenderStream();
    const editor: unknown[] = [];
    const sidebar: unknown[] = [];

    const detachEditor = stream.bindSink((message) => editor.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "one" } });
    const detachSidebar = stream.bindSink((message) => sidebar.push(message));
    stream.emit({ type: "event", event: { kind: "delta", text: "two" } });

    assert.equal(stream.hasSink, true);
    assert.deepEqual(editor, [
        { type: "event", event: { kind: "delta", text: "one" } },
        { type: "event", event: { kind: "delta", text: "two" } },
    ]);
    assert.deepEqual(sidebar, editor);

    detachSidebar();
    stream.emit({ type: "event", event: { kind: "delta", text: "three" } });
    assert.equal(sidebar.length, 2);
    assert.equal(editor.length, 3);

    detachEditor();
    assert.equal(stream.hasSink, false);
});
