import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const statusbar = readFileSync(resolve(__dirname, "../../src/ui/webview/statusbar.ts"), "utf8");
const events = readFileSync(resolve(__dirname, "../../src/ui/webview/events.ts"), "utf8");
const css = readFileSync(resolve(__dirname, "../../src/ui/webview/chat.css"), "utf8");
const surface = readFileSync(resolve(__dirname, "../../src/ui/chatSurface.ts"), "utf8");
const dialogues = readFileSync(resolve(__dirname, "../../src/ui/surfaceDialogues.ts"), "utf8");

test("quota badge is available by pointer, keyboard focus, and click", () => {
    assert.match(statusbar, /addEventListener\("mouseenter"/);
    assert.match(statusbar, /addEventListener\("focus"/);
    assert.match(statusbar, /addEventListener\("click"/);
    assert.match(statusbar, /aria-haspopup/);
    assert.match(css, /\.tokenMeter:focus-visible/);
});

test("quota panel renders semantic dynamic progress bars", () => {
    assert.match(events, /ev\.kind === "quota"/);
    assert.match(statusbar, /setAttribute\("role", "progressbar"\)/);
    assert.match(statusbar, /quota\.windows/);
    assert.doesNotMatch(statusbar, /"(?:five_hour|seven_day|primary|secondary)"/);
});

test("quota badge renders only the current conversation adapter", () => {
    assert.match(statusbar, /function currentQuotaSnapshot/);
    assert.match(statusbar, /quotaByBackend\.get\(current\)/);
    assert.doesNotMatch(statusbar, /const quotaProviders/);
    assert.doesNotMatch(statusbar, /snapshots\[0\]/);
    assert.match(statusbar, /statusbar\.appendChild\(quotaMeter\)/);
    assert.match(statusbar, /This adapter has not reported usage limits yet/);
    assert.match(statusbar, /type: "refresh-quotas"/);
    assert.match(statusbar, /quotaPopoverOpen/);
    assert.match(css, /\.quotaMeter\.quotaEmpty/);
});

test("chat surface asks only the active adapter usage singleton", () => {
    assert.doesNotMatch(surface, /loadCachedAdapterQuotas/);
    assert.match(surface, /const usage = this\.activeUsage/);
    assert.match(surface, /const snapshot = await usage\.read\(force\)/);
    assert.match(surface, /generation !== this\.quotaGeneration/);
    assert.match(surface, /setInterval\(\(\) => void this\.refreshQuotas\(\), 60_000\)/);
    assert.match(surface, /type: "quota-loading"/);
    assert.match(dialogues, /activateUsage: \(adapter: AgentAdapter\)/);
    assert.equal((dialogues.match(/this\.d\.activateUsage\(adapter\)/g) || []).length, 3);
});

test("quota animation respects reduced-motion preferences", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.quotaPop \.qFill \{ transition: none; \}/);
    assert.match(css, /\.quotaMeter\[aria-busy="true"\] \.tmRing \{ animation: none; \}/);
});
