# Gate Tool-Scoped System Prompt Sections on Tool Binding — Design

**Date:** 2026-09-13
**Status:** Draft
**Related:** [Issue #154](https://github.com/tkottke90/amazing-hashbrown/issues/154)

---

## Goal

`buildHarnessPrompt()` in `api/src/agents/system-prompt.ts` unconditionally includes every entry in `HARNESS_SECTIONS` regardless of whether the tools those sections describe are actually bound for the current call. This has already caused a real failure: with `wiki_create_page` excluded from the bound tool schema (auto-eval round E-12, `suites/instruction-sensitivity.yaml`), the model still tried to act on a "to ingest into wiki:" instruction block describing a tool it couldn't call, reasoning about a placeholder title and asking the user to supply one. The workaround applied at the time was a wording patch teaching the model to recognize a tool described in the prompt that it can't actually call — treating a structural problem as a wording problem.

This design makes each tool-scoped section's presence in the assembled prompt conditional on that tool actually being bound, so a session that doesn't have a given tool never receives prompt guidance describing how to use it.

**Note on prior art:** `docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §5` lists "Closes issue #154" in its scope, but it implements a different, orthogonal feature — an opt-in, empty-by-default per-tool `instructions` field that gets appended to the prompt when a tool survives the filter. It does not touch `buildSystemPrompt()`, `HARNESS_SECTIONS`, or the workaround sentence in `WEB_FETCH_SECTION` that issue #154 explicitly asks to remove. Issue #154 remains open and unaddressed; this design is the actual fix.

---

## Problem

- `buildSystemPrompt()` is called once per cached agent build (keyed by `provider:model`, or `workspaceId:provider:model`), before any thread's tool configuration is known — see `_agents`/`_workspaceAgents` maps in `chat-agent.ts`. The full harness prompt, including every tool-scoped section, is baked into that cached string regardless of what any individual thread has bound.
- Per-call, per-thread tool binding is only resolved later, in `tool-access.middleware.ts`'s `wrapModelCall`, which already filters `request.tools` and injects optional per-tool `instructions` text — but never touches the static harness sections already baked into `request.systemMessage`.
- The eval harness (`bin/eval.ts`) never runs `tool-access.middleware.ts` at all. It calls `buildSystemPrompt()` directly and statically, while `lib/evaluations/src/runner.ts` separately computes each scenario's excluded-tool set (`excludeTools`) purely for binding `request.tools`. These two are disconnected today, which is why E-12 doesn't actually exercise this bug — the system prompt it evaluates against is identical regardless of `excludeTools`.
- `WEB_FETCH_SECTION` is not cleanly one-tool-scoped: most of it describes `web_fetch` itself, but a substantial closing portion (the "to ingest into wiki:" stub-recognition workflow, and the direct-write-after-fetch instructions) is really about `wiki_create_page`, a separate tool. `wiki_create_page` is marked `alwaysOn: true` in `tool-catalog.ts`, so the general per-tool enable/disable system (PR #180) can never toggle it off in production — the only place it's actually excluded today is the eval harness's `excludeTools` mechanism (simulating scoped wiki-write guardrails, e.g. issue #79). Gating the whole `WEB_FETCH_SECTION` on `web_fetch` alone would not fix E-12, since E-12 keeps `web_fetch` bound and excludes only the wiki tools.
- `ASK_USER_SECTION` has the same tool-scoped shape as the other four sections (it instructs the model to call `ask_user`), but `ask_user` is a toggleable, non-`alwaysOn` tool that's hard-excluded from sub-agent runs (`buildSubAgentAgent`, per the redesign doc §6). A sub-agent run today is told to call a tool it never has.

---

## Scope

**In scope:**

- Add an optional tool-requirement to each `HarnessSection` entry in `system-prompt.ts`.
- Add one new pure function, `filterHarnessSections()`, that strips a section's tagged block from an assembled prompt string when its required tool(s) aren't in a given available-tool-id set.
- Split `WEB_FETCH_SECTION` into two independently-gated sections: fetch-only guidance (tag `web_fetch`, requires `web_fetch`) and wiki-ingest guidance (new tag `wiki_ingest`, requires `wiki_create_page`).
- Remove the workaround sentence in the old `WEB_FETCH_SECTION` ("This only applies when wiki_create_page is actually available...") — replaced by structural omission of the `<wiki_ingest>` block. A short, unconditional fallback sentence (present the stub's summary, note write access isn't available) moves into the `<web_fetch>`-gated section itself, since it only depends on `web_fetch` being bound.
- Gate `RLM_SECTION` (requires `rlm_query`), `SHELL_EXECUTION_SECTION` (requires `shell_exec`), `ASK_USER_SECTION` (requires `ask_user`), and `WIKI_NAVIGATION_SECTION` (requires any of the 10 `wiki_*` tool ids).
- Wire `filterHarnessSections()` into `tool-access.middleware.ts`'s `wrapModelCall`, using its already-resolved effective tool-id set.
- Wire the same function into `bin/eval.ts`, using each scenario's resolved bound-tool set (`evalTools` minus `excludeTools`), so `suites/instruction-sensitivity.yaml`'s E-12 actually exercises this fix.
- Update `system-prompt.test.ts`'s section-count/order assertions for the new `wiki_ingest` tag.

**Out of scope:**

- `identity` and `memory` stay unconditional — cross-cutting, not tied to a specific tool.
- No change to `buildSystemPrompt()`'s signature, call sites, or the agent-build caching model (`_agents`/`_workspaceAgents`) — the cached string still contains every section; filtering happens per-call, on top.
- No change to the opt-in per-tool `instructions` field or its injection — that stays exactly as shipped, and continues to run after section-filtering in the same middleware pass.
- No change to `buildTaskAgent`/autonomous runs beyond whatever `tool-access.middleware.ts` already does for them today.

---

## Design

### 1. Section metadata

```ts
interface HarnessSection {
  tag: string;
  content: string;
  // Tool ids this section's guidance depends on. Omitted = always included.
  // Present in more than one id = include if ANY of them is bound.
  requiresAnyOf?: string[];
}
```

`HARNESS_SECTIONS` becomes:

| tag                   | requiresAnyOf                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`            | _(none)_                                                                                                                                                                                    |
| `memory`              | _(none)_                                                                                                                                                                                    |
| `wiki_navigation`     | `wiki_search`, `wiki_read_page`, `wiki_locate`, `wiki_orient`, `wiki_lint`, `wiki_register_domain`, `wiki_create_page`, `wiki_update_page`, `wiki_add_cross_link`, `wiki_rebaseline_source` |
| `web_fetch`           | `web_fetch`                                                                                                                                                                                 |
| `wiki_ingest` _(new)_ | `wiki_create_page`                                                                                                                                                                          |
| `rlm`                 | `rlm_query`                                                                                                                                                                                 |
| `shell_execution`     | `shell_exec`                                                                                                                                                                                |
| `ask_user_routing`    | `ask_user`                                                                                                                                                                                  |

Section order in the array stays: identity, memory, wiki_navigation, web_fetch, wiki_ingest, rlm, shell_execution, ask_user_routing.

### 2. Splitting `WEB_FETCH_SECTION`

Content moves as follows (paragraph references are to the current file):

- **Stays in `web_fetch`** (requires only `web_fetch`): the tool definition; the fetch-before-route-before-write ordering guidance; the compact-stub shape description (recognizing the `── CONTENT OFFLOADED ──` header, summary/key-concepts fields); `get_tool_key` guidance for uses unrelated to wiki-writing (answering in more detail, quoting a passage, working with the full document). A new short, unconditional closing sentence: when a stub carries a "to ingest into wiki:" block but write access isn't available this session, present the stub's summary/key concepts as the answer and say plainly that wiki write access isn't available — no mention of `wiki_create_page` or the ingest workflow by name, since this section doesn't know whether `wiki_ingest` is present.
- **Moves to `wiki_ingest`** (requires `wiki_create_page`): the direct-write-with-inline-corpus instructions and code example; the "to ingest into wiki:" block recognition and instruction-following paragraphs (copy `threadId`/`toolKey` verbatim, don't ask for confirmation); the placeholder-title-is-a-naming-task paragraph; the "stub without that literal heading" contrastive paragraph.
- **Removed entirely**: the old trailing "This only applies when wiki_create_page is actually available to you right now..." paragraph.

Exact prose is an implementation-time task, not fixed by this design — the auto-eval loop (`suites/web-fetch.yaml`, `suites/instruction-sensitivity.yaml`) is this repo's established way of validating section wording, and should be re-run after the split lands (see Testing).

### 3. `filterHarnessSections()`

```ts
export function filterHarnessSections(prompt: string, availableToolIds: Set<string>): string;
```

For each `HARNESS_SECTIONS` entry with `requiresAnyOf` where no id in that list is present in `availableToolIds`, removes the exact `<tag>\n...\n</tag>` block (and its surrounding blank-line separator) from `prompt`. Entries with no `requiresAnyOf` are never touched. Pure string transform — no dependency on tool-config, thread store, or agent-build state — so it's testable with literal fixture strings.

`buildSystemPrompt()` itself is unchanged: still takes no tool-id argument, still returns every section, still cached exactly as today. Filtering is a separate, explicit step callers apply on top.

### 4. Wiring — production

In `tool-access.middleware.ts`'s `wrapModelCall`, immediately after `enabledIds` is resolved (and before the existing instruction-block injection), add:

```ts
const baseContent = filterHarnessSections(request.systemMessage.content as string, enabledIds);
```

replacing the current unfiltered read of `request.systemMessage.content`. The rest of the function (instruction-block collection and appending) proceeds unchanged, operating on the now-filtered `baseContent`. This mirrors the existing pattern exactly — a per-call transform layered on top of the cached, agent-build-time prompt, never mutating the cache itself.

### 5. Wiring — eval harness

`bin/eval.ts` currently builds the system prompt once, statically:

```ts
const systemPrompt = suite?.suite.simulatedUserInstructions
  ? ...
  : buildSystemPrompt(suite?.suite.simulatedUserInstructions);
```

`runner.ts` already computes, per scenario, `excluded = new Set(scenario.excludeTools ?? [])` (lines 493, 557) when binding `evalTools`. This design exposes that same resolved set at the point the system prompt is assembled for a scenario, and applies `filterHarnessSections(basePrompt, availableIds)` there, where `availableIds` is every `evalTools` entry's tool id minus `excluded`. Exact plumbing (whether this moves into `runner.ts` alongside the existing tool-binding logic, or `bin/eval.ts` computes and passes it forward) is an implementation detail; the requirement is that the prompt a scenario evaluates against reflects the same tool exclusions that scenario's bound tools reflect — which is the actual reason E-12 doesn't validate this fix today.

---

## Testing

- Unit (`system-prompt.test.ts`): each gated section is present when its required tool id is in the available set and absent when it isn't; `identity`/`memory` are never removed regardless of the set; `web_fetch` and `wiki_ingest` gate independently of each other (all four combinations of bound/unbound `web_fetch` × `wiki_create_page`); update the existing "7 open/7 close tags" and fixed-order assertions for the new 8-tag shape.
- Unit (`tool-access.middleware.test.ts`): a thread with `shell_exec` disabled never receives `<shell_execution>` in that call's system message; a thread with every tool enabled receives all eight tags.
- Eval: re-run `suites/instruction-sensitivity.yaml` (E-12 must pass without the removed workaround sentence — this is the issue's own stated acceptance criterion), `suites/web-fetch.yaml`, `suites/rlm.yaml`, `suites/shell-execution.yaml`, and `suites/wiki-navigation.yaml` via the auto-eval loop to catch any wording regression introduced by the `WEB_FETCH_SECTION` split.
