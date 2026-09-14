# Explicit Tool Syntax for Chat Messages and Skill Instructions — Design

**Date:** 2026-09-14
**Status:** Draft
**Related:** [Issue #172](https://github.com/tkottke90/amazing-hashbrown/issues/172)

---

## Goal

Let a user explicitly require a specific tool for their request by writing `#tool-name` anywhere in a chat message (`#duckduckgo-mcp-search What's new in AI?`). The system detects this, tells the model it must use that tool (without touching what the user actually typed), documents the notation in the system prompt alongside the existing `/skill-name` syntax, and gives users a discoverable way to find valid tool names while typing — a `#`-triggered autocomplete dropdown, the way `/`-skill invocation already has one.

---

## Problem

When multiple tools with similar capabilities are bound (e.g. a generic `web_fetch` vs. an MCP search tool), the model's tool choice is ambiguous. Users have no way to force a specific tool short of writing prose and hoping the model infers it correctly.

---

## Prior art this design reuses

- **`/skill-name` detection and expansion** — `api/src/agents/skill-expansion.middleware.ts`. A `beforeAgent` hook rewrites the *latest* human message's content for the LLM call only; the checkpoint always keeps the original raw text. Unknown skill names get an inline bracketed marker (`[Skill "/x" not found — ...]`) substituted in rather than an error response.
- **Cross-middleware state passing** — `api/src/agents/skill-gated-tools.middleware.ts`'s `gatedSkillStateSchema` (`z.object({ activeGatedSkill: z.string().nullable().default(null) })`). One middleware's `beforeAgent` writes a field; a later middleware's `wrapModelCall` reads it via `request.state.<field>`. This is the established mechanism for "detect something early, act on it later where the data you need is already computed."
- **Per-call system-message instruction blocks** — `api/src/agents/tool-access.middleware.ts`'s `instructionBlocks`/`<tool_guidance:id>` construction (lines ~102–115, ~139–141). Built fresh on every model call from the thread's already-resolved effective tool-id set (`enabledIds`, via `resolveEffectiveToolIds`), appended to the (already `filterHarnessSections()`-filtered, per issue #154) system message. This is the closest existing analog to the issue's "message footer," and the natural home for `<required-tool>` blocks — same tool-id set, same append point.
- **Tool-scoped system-prompt sections** — `docs/superpowers/specs/2026-09-13-tool-scoped-system-prompt-sections-design.md` (issue #154). Establishes the pattern that structural prompt content lives in `system-prompt.ts`, and dynamic/per-call content is layered on top inside `tool-access.middleware.ts`. This design's new system-prompt section (§4) and `<required-tool>` blocks (§3) both follow that split.
- **`/`-skill autocomplete dropdown** — `ui/src/components/chat-input.tsx` (`handleValueChange`, `selectSkill`) plus `ui/src/services/skills-api.ts`. Debounced fetch on typed prefix, inline positioned dropdown, Arrow/Enter/Escape/Tab keyboard nav. Reused for visual/interaction style only — its trigger detection (`startsWith('/')` on the whole input) and selection behavior (replace the entire textarea value) do **not** carry over as-is; see §5.

---

## Decisions already settled (via brainstorming Q&A)

| Question | Decision |
|---|---|
| Footer visible in chat UI? | No — hidden from the rendered chat, same as skill expansion. Visible to the LLM and to whatever already captures the outbound model request for observability (inherited for free — no new observability work). |
| Force-bind a disabled/unavailable tool? | No. `#tool-name` only adds emphasis among tools already bound for the call. Never overrides thread/global tool-access gating. |
| Unknown or disabled `#tool-name`? | Silently ignored. No error marker, no user-facing feedback, no log noise. Same handling whether it's a typo or a real-but-disabled tool. |
| Match precision | Exact, case-sensitive match against a tool's full display id (e.g. `web_fetch`, `playwright:browser_click`). No fuzzy or short-name matching. |
| Token boundary | `#` followed by `[a-z0-9][a-z0-9_:-]*`, terminated at the next character outside that class (whitespace or punctuation). Trailing punctuation (`#web_fetch.`) is not consumed into the candidate token. |
| Footer placement | System-message block (new `<required-tool id="...">` blocks), not a human-message rewrite — see Architecture §1 for why. |
| Dropdown tool list | Enabled tools only for the current thread. Nothing shown can silently no-op if selected. |

---

## Scope

**In scope:**
- Detect `#tool-name` tokens (one or more, anywhere in the message) in the latest human message, after skill expansion has run.
- Validate each candidate against the thread's currently-bound/enabled tool ids; append one `<required-tool id="...">` block per match to the per-call system message.
- New always-on system-prompt section documenting `/` (skill) and `#` (required tool) notation.
- New `#`-triggered autocomplete dropdown in the chat input, listing enabled tools for the thread, replacing only the `#token` span at the caret on selection.
- Unit tests for detection, validation/injection, and system-prompt content; frontend tests for dropdown trigger/selection.

**Out of scope:**
- Force-binding a tool that isn't currently enabled for the thread.
- Fuzzy or partial tool-name matching.
- Any user-facing error/warning UI for an unmatched `#tool-name` (silently ignored per the decision above).
- Wiring this into `bin/eval.ts` / the auto-eval harness. Issue #154's design doc flagged that harness as disconnected from the production middleware chain for a related reason (`filterHarnessSections` needed separate wiring there); the same caveat likely applies here, but extending eval coverage is a follow-up, not part of this design.
- Rewriting or otherwise touching the raw human message content. It is never modified by this feature.

---

## Design

### 1. Architecture

Two new/extended pieces, following the `skillExpansionMiddleware` → `skillGatedToolsMiddleware` state-passing shape exactly:

**`api/src/agents/tool-syntax.middleware.ts` (new)** — a `beforeAgent` hook registered in `chat-agent.ts`'s middleware array immediately after `skillExpansionMiddleware`:

```
recursionGuardMiddleware,
skillExpansionMiddleware,
toolSyntaxMiddleware,        // new
skillGatedToolsMiddleware,
toolAccessMiddleware,
createContextWindowMiddleware(...),
afterAgentMiddleware,
```

Running after `skillExpansionMiddleware` means this middleware always sees the *final* content for the turn — if a skill was invoked, that's the expanded skill body plus the user's trailing args; otherwise it's the user's raw message. Either way, one code path finds every `#tool-name` token regardless of whether it came from the user's own words or was carried through in a skill's args. This is also how the issue's second requirement ("apply the same tool syntax to skill instructions, after skill population, before the LLM call") is satisfied — it isn't separate work, it falls out of running this middleware after `skillExpansionMiddleware` in the existing chain.

It finds the latest human message the same way `skillExpansionMiddleware` does (walk `state.messages` backwards to the last `human`-typed entry), regex-scans its string content (see §2), dedupes matches, and writes them to new shared state:

```ts
export const toolSyntaxStateSchema = z.object({
  requestedToolIds: z.array(z.string()).default([]),
});
```

It does **not** validate tokens against bound tools and does **not** modify the message. Both of those need the effective tool-id set, which isn't resolved yet at this point in the chain — that's `tool-access.middleware.ts`'s job, and it's already computed there (§3).

**`api/src/agents/tool-access.middleware.ts` (extended)** — reads `request.state.requestedToolIds` inside the existing `wrapModelCall`, at the point where `enabledIds` and `displayIdByMatchKey` are already built (lines ~62–92 today). No new resolution logic — this is the one and only place the effective tool-id set is computed for a call, and this feature reuses it rather than duplicating it elsewhere.

Why a system-message block and not a human-message rewrite (like skill expansion does): validating a `#tool-name` against the bound-tool set requires `enabledIds`, which is only available inside `tool-access.middleware.ts`. Rewriting the human message would mean either resolving that set a second time earlier in the chain (duplicated logic, two places that can drift) or reordering the middleware chain around this one feature. Appending to the system message, where the required data already lives, avoids both.

### 2. Detection

```
/#([a-z0-9][a-z0-9_:-]*)/g
```

Applied to the (possibly skill-expanded) latest human message's string content only. Historical messages in the conversation are never touched. Case-sensitive. Matches are deduplicated (a `#web_fetch` mentioned twice in one message produces one `<required-tool>` block, not two).

The human message itself is never rewritten by this feature — the `#token` text stays exactly as the user typed it, visible to the model as part of their own words, same as it would be if this feature didn't exist.

### 3. Validation and footer construction

Inside `tool-access.middleware.ts`, immediately after `enabledIds`/`displayIdByMatchKey` are computed:

```ts
const requiredToolBlocks = request.state.requestedToolIds
  .filter((id) => enabledIds.has(id))
  .map((id) => `<required-tool id="${id}">The user has explicitly asked that you use the ${id} tool to complete this request</required-tool>`);
```

`requiredToolBlocks` is appended to the system message the same way `instructionBlocks` is today — joined in after the filtered harness content and any `<tool_guidance:id>` blocks. A `requestedToolIds` entry not present in `enabledIds` (typo, or a real tool that's currently disabled) is dropped by the `.filter()` with no further handling — same code path for both cases, no way to distinguish "doesn't exist" from "exists but disabled," which is intentional (§ Decisions: both are silently ignored).

If `requestedToolIds` is empty (the common case — no `#` in the message), this filter/map produces an empty array and nothing new is appended; behavior is byte-for-byte identical to today.

### 4. System prompt notation section

A new entry in `HARNESS_SECTIONS` (`api/src/agents/system-prompt.ts`), always-on (no `requiresAnyOf`, same as `identity`/`memory`), placed early in the array since it's cross-cutting notation guidance rather than tool-specific. Content covers:

- `/skill-name` — invokes a skill (existing behavior, documented for completeness).
- `#tool-name` — the user is explicitly requiring that tool be used for this request; treat a `<required-tool id="...">` instruction as a directive, not a suggestion, when present.
- An unrecognized or currently-unavailable `#name` produces no instruction and needs no reaction — it is not an error to comment on or ask the user about.

Exact prose is an implementation-time task per the same convention issue #154 established for its own section wording (validated via the auto-eval loop, not fixed by this design).

### 5. UI: `#`-tool autocomplete dropdown

**Reused as-is:**
- Data: `fetchThreadTools(threadId)` (`ui/src/services/tool-settings-api.ts`), already backing the Edit Tools drawer. Returns `ThreadToolItem[]` with `toolId`, `name`, `description`, `enabled`. No new API endpoint.
- Visual/keyboard shell: inline-positioned dropdown, Arrow Up/Down to navigate, Enter/Tab to select, Escape to close, mouse hover/click — same interaction contract as the `/`-skill menu.

**Not reused — different trigger and selection mechanics:**
The existing `/`-skill dropdown (`chat-input.tsx`) triggers only when `/` is the first character of the entire input (`newValue.startsWith('/')`) and, on selection, replaces the *whole* textarea value (`onValueChange(`${skill.slashCommand} `)`). That matches `/skill`'s own whole-message-prefix semantics. `#tool-name` must work "regardless of message position" and support multiple occurrences in one message (per the issue's explicit requirement and the multi-tool example), so the trigger needs real cursor-relative detection instead:

- On each keystroke, inspect the token immediately preceding the caret. If it matches `#` followed by the in-progress name (§2's character class), open the dropdown filtered by what's typed so far.
- On selection, replace only that `#token` span (from the `#` to the caret) with the chosen tool's id plus a trailing space — never the full message content.
- The dropdown can retrigger later in the same message for a second `#`, since detection is caret-relative rather than whole-string.
- List is filtered to `enabled: true` tools for the current thread (per the settled decision) — nothing shown can silently no-op if picked, consistent with §3's server-side behavior.
- Fetch is debounced the same way `fetchSkills` is today (`skills-api.ts` pattern), since `fetchThreadTools` isn't kept warm outside the Edit Tools drawer currently — first `#` keystroke in a thread triggers a fetch.

### 6. Data flow (single turn, worked example)

1. User types `#web_fetch check this article https://example.com`, sends.
2. Route handler stores the raw text in the checkpoint, invokes the graph.
3. `skillExpansionMiddleware` (`beforeAgent`) — no `/` prefix, no-op.
4. `toolSyntaxMiddleware` (`beforeAgent`) — finds `web_fetch`, writes `{ requestedToolIds: ['web_fetch'] }` to state.
5. `skillGatedToolsMiddleware` (`wrapModelCall`) — unrelated, passes through.
6. `toolAccessMiddleware` (`wrapModelCall`) — resolves `enabledIds`; `web_fetch` is in it; appends `<required-tool id="web_fetch">...</required-tool>` to the system message, after the `filterHarnessSections()`-filtered content and any `<tool_guidance>` blocks.
7. Model receives: the user's message completely unmodified, plus a system message carrying the gated harness sections (#154), any per-tool guidance, and the new required-tool block.

---

## Testing

- **Unit — `tool-syntax.middleware.test.ts` (new):** single token; multiple distinct tokens; duplicate token dedup; token embedded in skill-expanded body vs. in trailing args; message with no `#` produces empty `requestedToolIds`; message content is unchanged in all cases.
- **Unit — `tool-access.middleware.test.ts` (extended):** a requested-and-enabled tool id produces exactly one `<required-tool>` block; a requested-but-disabled or unknown id produces none; `requestedToolIds` empty leaves output identical to current behavior; a requested id combined with existing `<tool_guidance>` content for the same tool produces both blocks correctly ordered.
- **Unit — `system-prompt.test.ts` (extended):** new notation section present unconditionally regardless of bound-tool set; update fixed section-count/order assertions for the new entry.
- **Frontend — `chat-input` component tests (extended):** `#` mid-message opens the dropdown; `#` at message start still works; typing after `#` filters the list; selecting an item replaces only the token span, not the full input; a second `#` later in the same message retriggers the dropdown; only enabled tools appear in results.
- **Eval:** none added by this design (see Scope — out of scope). Flagged as a candidate follow-up for `suites/*.yaml` once the harness's disconnect from `tool-access.middleware.ts` (per #154's own notes) is addressed generally.
