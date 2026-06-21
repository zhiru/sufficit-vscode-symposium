# PLAN — Context Management: Ledger (lossless) + /compact (smart)

Status: ledger shipped · compaction = design only (not for now, just thinking)
Scope: **Sufficit AI / OpenAI HTTP backend only** — the one backend where Symposium
controls the exact wire payload, so it can both *truncate* and *rewrite* context.
CLI backends (Claude/Codex/Copilot) own their own `/compact` and are out of scope.

## The one idea

Two halves of a single context-management system:

| Half | What | Property |
|---|---|---|
| **Ledger** | git repo per session, append-only | **lossless** — never forgets |
| **/compact** | summarize old turns into a short synthetic message | **lossy but smart** — shrinks the live context |

They are not separate features — **the ledger is what makes aggressive compaction
safe**. Because every raw message is already committed to git, `/compact` can throw
away the middle of `this.messages` without ever losing anything: the original is one
`git show` away, and the model can pull it back with the `read_session` tool.

```
LEDGER (lossless, audit + human view)        LIVE CONTEXT (compacted, what the LLM sees)
~/.symposium/ledger/<id>/                    ~/.symposium/sessions/openai/<id>.json
  messages.jsonl   every raw message    →    this.messages[] after /compact:
  request-last.json literal wire body          [ system/developer prefix ]
  meta.json                                     [ SUMMARY of turns 1..N-K ]   ← synthetic
  (git: one commit per turn)                    [ verbatim last K turns ]
        ▲ recover via read_session tool / "Full history" view
```

## What we already have (do not rebuild)

- **`src/ledger.ts`** — `ensureLedger / appendMessage / recordRequest / commitTurn /
  readMessages / timeline / hasLedger / removeLedger`. Git-isolated (own identity,
  `core.hooksPath=/dev/null`, unsigned, quiet). One commit per turn.
- **Wired in `src/adapters/openai.ts`**: `ensureLedger` on construct, `appendMessage`
  on every user/developer/assistant push, `commitTurn` per turn, seed-on-resume.
- **`windowedMessages()`** — today's "compaction": keeps the system/developer prefix
  + the last `maxHistoryMessages` (~40) turns, **drops the middle** of each request.
  Crude (no summary) but cheap and safe. This becomes the *fallback*, not the primary.
- **`sessionReader.readSession()` + `read_session` AI tool** — the model can re-read
  the **lossless ledger** on demand to recover anything truncated/compacted out.
  This already is a ledger↔context bridge; compaction strengthens it.
- **Token meter / `usage` events** (contextWindow + inputTokens) — now emitted by the
  OpenAI backend, so we can **measure fullness** and trigger compaction by threshold.

### Gaps to close
- `recordRequest()` exists but is **never called** → `request-last.json` is not written.
  Wire it (write the literal body before each `fetch`). Cheap, high audit value.
- No real summarization anywhere — only truncation. `/compact` is the new piece.
- No UI to browse the ledger / see where compaction happened.

## Design: our own `/compact` (OpenAI / Sufficit AI)

### Trigger
1. **Manual** — user types `/compact`, intercepted in `openai.send()` (do NOT ship it
   to the gateway as a user turn). Register a `compact` builtin command so it appears
   in autocomplete + re-enables the popover "Compact Conversation" button for this
   backend (today it is gated off — see `chatClient.ts openUsagePopover`).
2. **Auto** — after a turn, if `inputTokens / contextWindow >= autoCompactAt`, compact
   before the next send. New setting `symposium.openai.autoCompactAt` (default `0.8`,
   `0` = off). Uses the usage numbers the meter already receives.

### What compaction does (on `this.messages`)
1. Split into three regions:
   - **prefix** — everything before the first user msg (system/developer policy, agent
     def). **Never summarized** — it is re-injected anyway.
   - **tail** — the last `keepTurns` exchanges (default ~6 messages). **Kept verbatim**;
     recency dominates correctness.
   - **middle** — everything between. **This is what gets summarized.**
2. Ask the model (same backend; optionally a cheaper `symposium.openai.compactModel`)
   to summarize the middle with a structured prompt: preserve **decisions, facts,
   file paths touched, open tasks/todos, key tool results, user constraints**; drop
   chatter. Bounded output (e.g. ≤ 1500 tokens).
3. Replace the middle in `this.messages` with **one synthetic message**:
   `{ role: developer|system, content: "[Conversation summary so far]\n…" }`
   inserted right after the prefix (sits with the preamble → role alternation stays
   valid for Anthropic-backed gateways; no user→user / assistant→assistant).
4. Result: `this.messages` is now small → next request is small → **token meter drops**.
   `windowedMessages()` becomes a no-op for a while (set has shrunk under the cap).

### The ledger join (the whole point)
- **Before** compacting, the raw middle is **already in `messages.jsonl`** (appended
  every turn) — nothing to back up, it is inherently safe.
- Append a **compaction marker** to the ledger and commit it:
  `appendMessage(id, { role:"system", kind:"compaction", turn, summarizedCount:N,
  keptTail:K, summary, at })` → `commitTurn(id, "compact — folded N msgs (model=…)")`.
- **Two sources, two readers, by design:**
  - **Store (`<id>.json`) = the compacted live context.** What `resume` loads into
    `this.messages` so the model continues cheap.
  - **Ledger = lossless.** What `read_session` and the "Full history" view read, so the
    **human always sees the real conversation** even though the model sees the summary.
- **Resume** therefore reconstructs the *human transcript* from the **ledger**, while the
  *model context* loads from the **compacted store** — the elegant split this plan adds.
- **Idempotent**: compacting an already-compacted session folds the previous summary
  message into the new one (summarize `[old summary] + new middle`), never stacks.
- **Fail-safe**: if summarization errors (network/HTTP), **fall back to today's
  `windowedMessages()` truncation** and emit a quiet toast. Compaction never blocks or
  breaks a turn (same rule as all ledger writes).

### UI
- Re-enable the popover **"Compact Conversation"** button for OpenAI once `compact` is a
  real intercepted command (the `commands.some(c=>c.name==="compact")` gate already
  handles visibility — just register the builtin).
- Chat command **"Full history (ledger)"** — loads `ledger.readMessages()` instead of the
  compacted store, so the user can always expand the real exchange.
- Render a **`⊟ compacted here`** divider at each compaction marker (drive it from the
  ledger marker, not a message-count heuristic). Tooltip: N folded, model, timestamp.
- The token meter already shows the drop after compaction — no extra UI needed there.

## Phases
1. **Ledger audit polish** — wire `recordRequest()` (write `request-last.json` before
   each `fetch`); add the `kind:"compaction"` marker shape to `LedgerMessage`.
2. **Core /compact** — region split + summarization call + synthetic-summary rewrite of
   `this.messages`, behind a manual `/compact` intercept in `send()`. Fall back to
   truncation on failure.
3. **Ledger join** — compaction marker + commit; resume reads human transcript from
   ledger, model context from compacted store; idempotent re-compaction.
4. **Auto-compaction** — `symposium.openai.autoCompactAt` threshold using `usage`.
5. **UI** — re-enable Compact button, "Full history (ledger)" view, `⊟ compacted here`
   divider from markers.

## Open questions (decide before building)
- Summarize with the **same model** (simplest, consistent) or a dedicated cheap
  `compactModel` (cheaper, but a second model's view of the context)? Lean same-model.
- `keepTurns` / summary token budget defaults — tune against the real contextWindow now
  that the meter reports it (e.g. keep tail ≈ 15% of window, summary ≤ 10%).
- Should tool-result messages be summarized or **dropped with a pointer** ("ran X, see
  ledger commit <hash>")? Pointers keep the summary tight and lean on the ledger.
</content>
</invoke>
