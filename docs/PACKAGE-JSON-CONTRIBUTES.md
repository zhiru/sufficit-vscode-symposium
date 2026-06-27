# `package.json` `contributes` is load-bearing — don't gut it

The `contributes` block in `package.json` is the **only** declaration of the
extension's UI surface and settings. VS Code reads it at install/activation time;
nothing in `out/*.js` can recreate it. Deleting entries here silently removes UI.

## What each block powers

| Block | Powers | Symptom if removed |
|-------|--------|--------------------|
| `contributes.commands` | Command palette entries; the `command` referenced by every menu/keybinding | Commands vanish from the palette; menus that reference them render nothing |
| `contributes.menus["view/title"]` | The buttons in the editor/view **title bar** (New session, **Configuration**, **Reload**, …) | Top-bar buttons disappear — only VS Code's own `[split] [x]` remain |
| `contributes.configuration.properties` | Every user setting (`symposium.openai.*`, `symposium.claude.*`, `symposium.hub.*`, `symposium.adapters`, …) | All settings disappear from the Settings UI; user config silently reverts to code defaults |
| `contributes.keybindings` | Keyboard shortcuts | Shortcuts stop working |

## What happened (the regression this doc exists for)

A commit on `main` reduced `contributes` from **51 → 4** entries — every real
command, the whole `view/title` menu, and all configuration properties were
removed, leaving only a `maxBackends`/`enableDebugLogging` stub plus a
`switchContext` command **with no matching `registerCommand` in `src/`**.

Effect: the editor title bar lost its buttons (Reload, Configuration, New
session) and the entire Settings UI for Symposium went blank. It built and
type-checked fine — `contributes` is data, not code — so CI didn't catch it, and
a later merge propagated it.

## Rules

1. **Never bulk-delete `contributes` blocks.** To remove one command, delete only
   that command entry **and** its `menus`/`keybindings` references — not the array.
2. **Read the diff before committing `package.json`.** `git diff package.json` —
   a large red block under `contributes` (dozens of `-` lines) means STOP and
   re-check. Deletions there are almost always accidental (bad merge, editor
   "format/clean", AI rewrite).
3. **Keep `commands` ⊇ registered commands.** Every `vscode.commands.registerCommand("symposium.X")`
   should have a `contributes.commands` entry, and vice versa — no entry should
   point at a command that isn't registered (e.g. the dead `switchContext`).
4. **`contributes` survives refactors.** Bundling, lint passes, and src rewrites
   must not touch `package.json` `contributes`. If a tool rewrote it, revert it.

## Quick sanity check (run before pushing a `package.json` change)

```bash
node -e "const c=require('./package.json').contributes; \
console.log('commands', c.commands.length, '| view/title', (c.menus?.['view/title']||[]).length, \
'| settings', Object.keys(c.configuration.properties).length)"
# expect: dozens of commands, several view/title items, ~50 settings — NOT single digits
```

## Suggested CI guard

Add a test asserting minimum counts so a future gutting fails the build:

```js
const c = require("../package.json").contributes;
assert(c.commands.length >= 15, "contributes.commands gutted");
assert((c.menus?.["view/title"]||[]).length >= 4, "view/title menu gutted");
assert(Object.keys(c.configuration.properties).length >= 30, "configuration gutted");
```
