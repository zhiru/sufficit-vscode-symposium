import { test } from "node:test";
import assert from "node:assert/strict";
import { isBridgeAuthorized } from "../api/bridgeAuth";

test("bridge query token is accepted only for session follow SSE", () => {
    const token = "secret-token";

    assert.equal(
        isBridgeAuthorized(undefined, new URL(`http://localhost/sessions/abc/follow?token=${token}`), token),
        true,
    );
    assert.equal(
        isBridgeAuthorized(undefined, new URL(`http://localhost/sessions/abc/follow/?token=${token}`), token),
        true,
    );
    assert.equal(
        isBridgeAuthorized(undefined, new URL(`http://localhost/vault/resolve?reference=x&token=${token}`), token),
        false,
    );
    assert.equal(
        isBridgeAuthorized(undefined, new URL(`http://localhost/sessions?token=${token}`), token),
        false,
    );
});

test("bridge authorization header works for every endpoint", () => {
    const token = "secret-token";

    assert.equal(
        isBridgeAuthorized(`Bearer ${token}`, new URL("http://localhost/vault/resolve?reference=x"), token),
        true,
    );
});
