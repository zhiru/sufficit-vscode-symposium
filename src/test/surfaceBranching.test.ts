import test from "node:test";
import assert from "node:assert/strict";
import { editResend } from "../ui/surfaceBranching";
import type { SurfaceDialoguesDeps } from "../ui/surfaceDialogues";
import type { WebviewToHost } from "../ui/protocol";

function depsFor(controller: () => Record<string, unknown>): SurfaceDialoguesDeps {
    return {
        getController: () => controller(),
        post: () => undefined,
    } as unknown as SurfaceDialoguesDeps;
}

test("editResend retries unchanged Claude text in the same session", () => {
    let opened = 0;
    let handled: WebviewToHost | undefined;
    const controller = {
        backend: "claude",
        cwd: "/repo",
        title: "Deploy",
        transcriptMessages: () => [{ role: "user", text: "deploy now" }],
        handleMessage: (message: WebviewToHost) => { handled = message; },
    };

    editResend(depsFor(() => controller), () => { opened++; }, 0, {
        type: "send",
        text: "deploy now",
        editFrom: 0,
    });

    assert.equal(opened, 0);
    assert.equal(handled?.type, "send");
    assert.equal(handled?.text, "deploy now");
    assert.equal(handled?.editFrom, undefined);
});

test("editResend branches Claude when edited text changed", () => {
    let opened = 0;
    let oldHandled = 0;
    let newHandled = 0;
    const oldController = {
        backend: "claude",
        cwd: "/repo",
        title: "Deploy",
        transcriptMessages: () => [{ role: "user", text: "deploy now" }],
        transcriptMessagesUpTo: () => [],
        transcriptUpTo: () => undefined,
        handleMessage: () => { oldHandled++; },
    };
    const newController = {
        handleMessage: () => { newHandled++; },
    };
    let current = oldController;

    editResend(depsFor(() => current), () => {
        opened++;
        current = newController as typeof oldController;
    }, 0, {
        type: "send",
        text: "deploy endpoints",
        editFrom: 0,
    });

    assert.equal(opened, 1);
    assert.equal(oldHandled, 0);
    assert.equal(newHandled, 1);
});
