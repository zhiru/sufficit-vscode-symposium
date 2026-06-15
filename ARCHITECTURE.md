# Symposium — Architecture

Host and conduct dialogue sessions with multiple AI agents (Claude Code, Codex
CLI, GitHub Copilot CLI, and OpenAI-compatible HTTP backends like Sufficit AI)
inside VS Code. No runtime dependencies — VS Code API + Node only.

## Layers

```
adapters/            AgentAdapter + AgentSession contract, one per backend
  claude/codex/copilot   CLI-backed (spawn, stream-json / JSONL)
  openai                 HTTP-backed (chat completions OR responses), multi-instance
  todos / builtins / skills / scrub / exec   shared adapter helpers
sessions/
  runtime (LiveSessions)  registry of live ChatControllers (survive view switches)
  store (SessionStore)    per-session metadata in globalState (titles/archived/pinned)
ui/
  chatController     per-session state: stream coalescing, queue, injections
                     (todo/autonomy), edited-files tracking, snapshot coordination
  chatSurface        wires ONE webview to the machinery (ready handshake, git
                     filtering, active-file context, message routing)
  chatHtml           the chat VIEW (HTML+CSS+JS in one template literal) ⚠ large
  chatPanel/chatView editor-panel and sidebar hosts of a ChatSurface
  configPanel/configHtml   dynamic config webview (backends, resources, sync)
  terminalSession    terminal-backed sessions (visible CLI, driven by sendText)
api/
  symposiumApi       public facade over running state (sessions/backends/resources)
  bridge             optional remote control (HTTP + SSE), off by default
config/ root + seed  ~/.symposium vendor-neutral knowledge (agents/skills/tools)
sync/ hubClient+sync  pull/push against the sufficit-ai memory/vault hub
git.ts               diff/approve/reject + pendingChanges (two-way git sync)
snapshots.ts         per-session pre-edit baselines for revert without git
```

## Key flows

- **Session lifetime**: `runtime.create(adapter, options)` → `ChatController`
  owns the `AgentSession`; the controller keeps running when the view switches
  (detach/attach + replay log). Only explicit delete/dispose stops it.
- **Streaming**: adapters emit normalized `AgentEvent`s; the webview coalesces
  consecutive `text` deltas into one assistant message (Claude uses
  `--include-partial-messages`; OpenAI streams SSE deltas).
- **Edited files**: controller is the source of truth (survives switches); the
  surface filters it against live `git status` (staged → hidden, unstage →
  reappears) and pushes `changed-files` to the webview.
- **Revert**: snapshot (pre-edit baseline captured by the adapter) is primary;
  git restore is the fallback. Approve = `git add`.
- **GUID everywhere**: session id (UUID) is the canonical, backend-agnostic key
  (store, snapshots, persistence, future memory linking).

## Persistence map

| What | Where |
|------|-------|
| titles / archived / pinned order | `globalState` (SessionStore) |
| pre-edit snapshots | in-memory (per session, cleared on delete) |
| OpenAI/API transcripts | `~/.symposium/sessions/<backend>/<id>.json` |
| agents/skills/tools/instructions | `~/.symposium/repo` |
| extra adapters / settings | `settings.json` (`symposium.*`) |

## Known debt (see review 2026-06-15)

1. `chatHtml.ts` is a 2k-line template literal — webview JS is untyped and has
   template-escaping hazards. Highest-priority refactor (bundle + split).
2. The webview↔extension message protocol is stringly-typed and duplicated;
   hand-maintained field whitelists have caused drift bugs. → shared protocol.
3. No tests. Pure logic (summarizeToolInput, diffCounts, editDiff, parseTodos,
   pendingChanges, store ordering, snapshots) is the place to start.
4. `AgentAdapter` has ~10 optional capability methods → collapse into one
   `capabilities()`.
5. ChatController concentrates many responsibilities.
