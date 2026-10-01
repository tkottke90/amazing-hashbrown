# Ambient System-Prompt Context — Design

**Date:** 2026-10-01
**Status:** Proposed
**Related:** [Issue #244](https://github.com/tkottke90/amazing-hashbrown/issues/244), [Ambient context research](../../research/issue-244/01-ambient-context-survey.md), [Cron task triggers design](./2026-09-26-cron-task-triggers-design.md) (`env.timezone`)

---

## Goal

Give agents built in this repo a resolved, correct, always-current notion of "now" — without a tool call, and without ever going stale on a long-lived cached agent — starting with current date/time, and leave a clear, low-ceremony place to add the next evidence-backed ambient fact when one turns up.

---

## Problem

`buildSystemPrompt()` (`api/src/agents/system-prompt.ts`) gives the agent no information about its own situation. Concretely: `suites/task-creation.yaml`'s `tc-004` scenario asks the agent to schedule a task "tomorrow at 3pm"; to resolve "tomorrow" the model has no option but to burn a `shell_exec` call reading the system clock before it can call `create_tasks`. The reasoning is otherwise sound — the model is correctly compensating for a real gap, not making an arbitrary tool choice.

The [research survey](../../research/issue-244/01-ambient-context-survey.md) (primary-sourced against Anthropic's published claude.ai prompt, OpenAI's Harmony format, Aider's real source, and LangGraph/OpenAI's conversation-state docs) confirms current date/time is a near-universal convention with a stated rationale (keep the model's sense of "now" accurate), but found **no primary source that resolves "today" to anything other than UTC or the host machine's local time** — none inject it resolved to a configured/user timezone. That part is this repo's own design decision, not something to copy.

A second, repo-specific problem surfaced during design: `buildSystemPrompt()`'s output is cached per `provider:model` (and per workspace) in `chat-agent.ts`'s `_agents` / `_workspaceAgents` maps, invalidated only by explicit settings/workspace changes — not time-based. A value baked into that string at agent-build time can be stale for days.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Inject via a new **`wrapModelCall` middleware**, not a `HarnessSection` baked into `buildSystemPrompt()`'s cached string.                                                                                                                                                                       | The agent cache holds a constructed agent object, not a frozen per-call request. `tool-access.middleware.ts` already proves the pattern for the same reason (tool availability isn't known at agent-build time either): read `request.systemMessage`, build a fresh `SystemMessage`, hand it to `handler()` — done on every single model call regardless of how long the agent has been cached. |
| D2  | Resolve "today" against **`env.timezone`** (added in #243), never UTC or host-local.                                                                                                                                                                                                            | The one timezone decision no surveyed harness makes correctly. `env.timezone` already exists for exactly this purpose (cron schedules) — reuse it rather than introducing a second notion of "the server's timezone."                                                                                                                                                                           |
| D3  | Render with the existing **`formatRunTime()`** convention (`task-context.ts`) — `"2026-10-01 14:30 UTC"` — not a raw ISO string.                                                                                                                                                                | Already a proven, unambiguous, model-facing rendering in this codebase; inventing a second date format for the same purpose would be pure duplication.                                                                                                                                                                                                                                          |
| D4  | A new, **dedicated, growing file** (`ambient-context.ts`) holds one small provider per ambient fact, not a single hardcoded string.                                                                                                                                                             | Mirrors the existing `HARNESS_SECTIONS` array pattern. Keeps future additions (once evidence-backed) a one-entry diff instead of a rewrite, and keeps each fact's own typed shape instead of a generic `meta`-bag — the anti-pattern the root `AGENTS.md` explicitly warns against.                                                                                                             |
| D5  | The middleware is **decoupled from `buildSystemPrompt()`** — it only touches `request.systemMessage`, whatever produced it.                                                                                                                                                                     | Confirmed necessary: wiki ingestion/chat (`buildWikiIngestionAgent`) uses a completely separate system-prompt builder (`buildWikiIngestionSystemPrompt()`) and a shorter middleware chain with no `toolAccessMiddleware`. Decoupling lets every surface opt in independently.                                                                                                                   |
| D6  | Ship **only** the current-date/time provider in this change. Every other surveyed category (OS/platform, locale, session id, cwd for plain chat, model identity) is either rejected outright (no evidence, or — for session id — no precedent anywhere) or filed as a separate follow-up issue. | Issue #244's own bar: "backed by a concrete failure mode in this repo... not merely 'other harnesses do this too.'" Only date/time clears it today.                                                                                                                                                                                                                                             |

---

## Non-goals

- **OS/platform, locale.** Real precedent exists (Aider), but no failure mode exists in this repo. Not added; not filed as a follow-up either — there's nothing concrete to track yet.
- **Session/thread identifiers as prompt text.** The research found this is not a pattern anywhere surveyed (LangGraph `thread_id`, OpenAI `conversation_id` are both pure app-layer addressing keys, never written into the model's own context). Not added.
- **IDE/editor-style state.** Only found in unverified blog claims; Cursor's own docs don't confirm it. Not added.
- **Working directory for plain (non-workspace) chat.** `shell_exec` runs with `undefined` cwd and `SHELL_EXECUTION_SECTION` says nothing about it; workspace chat already covers this via `buildWorkspaceContextBlock()`'s `Location on disk:` line. Plausible gap, no logged failure — **follow-up issue**, with a suggested eval scenario, rather than speculative code here.
- **Model identity on provider/model switch.** Anthropic's stated rationale (a model can't infer its own identity from history when the user can swap models mid-conversation) matches this repo's architecture exactly — `resolveTurnModel(provider, modelName)` resolves per turn, and a thread's checkpointed history can span a provider/model switch. No eval reproduces a failure from this yet. **Follow-up issue**, with a suggested eval scenario, rather than speculative code here.

---

## Design

### 1. `api/src/agents/ambient-context.ts` (new)

```ts
import { formatRunTime } from './task-context.js';

export interface AmbientContextInput {
  timezone: string;
  /** Injectable for tests; defaults to `new Date()`. */
  now?: Date;
}

interface AmbientContextProvider {
  /** Mirrors HarnessSection.tag — a future selective-inclusion/testing hook, unused today. */
  tag: string;
  build: (input: AmbientContextInput) => string | null;
}

const CURRENT_TIME_PROVIDER: AmbientContextProvider = {
  tag: 'current_time',
  build: ({ timezone, now = new Date() }) =>
    `Current date and time: ${formatRunTime(now.toISOString(), timezone)}. "Today," "tomorrow," and similar relative dates resolve against this.`,
};

// Every future entry (see issue #244's research doc) lands here as its own
// provider, added only once backed by a confirmed failure mode — not
// speculatively. One entry today.
const AMBIENT_CONTEXT_PROVIDERS: AmbientContextProvider[] = [CURRENT_TIME_PROVIDER];

export function buildAmbientContext(input: AmbientContextInput): string {
  return AMBIENT_CONTEXT_PROVIDERS.map((p) => p.build(input))
    .filter((line): line is string => line !== null)
    .join('\n');
}
```

### 2. `api/src/agents/ambient-context.middleware.ts` (new)

```ts
import { createMiddleware } from 'langchain';
import { SystemMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import { buildAmbientContext } from './ambient-context.js';

// Fresh on every model call, regardless of how long the parent agent has
// been cached (see tool-access.middleware.ts for the identical rationale).
export function createAmbientContextMiddleware(getNow: () => Date = () => new Date()) {
  return createMiddleware({
    name: 'AmbientContextMiddleware',
    wrapModelCall: async (request, handler) => {
      const baseContent = request.systemMessage.content;
      if (typeof baseContent !== 'string') return handler(request);
      const ambient = buildAmbientContext({ timezone: env.timezone, now: getNow() });
      const systemMessage = new SystemMessage(
        `${baseContent}\n\n<ambient_context>\n${ambient}\n</ambient_context>`,
      );
      return handler({ ...request, systemMessage });
    },
  });
}

export const ambientContextMiddleware = createAmbientContextMiddleware();
```

### 3. Wiring

Added to the `middleware` array of all five `createAgent()` call sites, since the content is universal and not tool-gated (the same reasoning `IDENTITY_SECTION`/`MEMORY_SECTION` already get unconditional inclusion everywhere):

| Builder                   | File                      | Placement                                                                |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `buildChatAgent`          | `chat-agent.ts`           | After `toolAccessMiddleware`, before `createContextWindowMiddleware`     |
| `buildWorkspaceChatAgent` | `chat-agent.ts`           | Same position                                                            |
| `buildTaskAgent`          | `chat-agent.ts`           | Same position                                                            |
| `buildSubAgentAgent`      | `chat-agent.ts`           | After `toolAccessMiddleware` (its chain has no snapshot middleware)      |
| `buildWikiIngestionAgent` | `wiki-ingestion-agent.ts` | Appended to its two-entry array (no `toolAccessMiddleware` there at all) |

Placed before `modelInputSnapshotMiddleware` wherever that middleware exists, so the observability snapshot (issue #207) captures the final, date-stamped prompt actually sent to the model.

### 4. Testing

- **`ambient-context.test.ts` (unit).** `buildAmbientContext()` is a pure function: inject `now`/`timezone`, assert the exact rendered line; assert resolution to the given timezone rather than UTC or host-local using a case where that changes the calendar day (e.g. 11pm Pacific = the next day in UTC).
- **`ambient-context.middleware.test.ts` (orchestration).** A stub `handler` capturing the `request` it receives, same style as `model-input-snapshot.middleware.test.ts`: assert the final `systemMessage.content` contains the base content plus the `<ambient_context>` block; assert two calls with different injected `now` produce different content — the test that directly proves the staleness problem (D1) is actually fixed on a single cached agent.
- Each of the 5 wiring sites gets a thin existing-test addition asserting the middleware array includes it.

### 5. Verification

Re-run `suites/task-creation.yaml`'s `tc-004` post-implementation and confirm the trace no longer shows a `shell_exec` call before `create_tasks` — the issue's own stated acceptance bar.

### 6. Follow-up issues to file

1. **Plain-chat `shell_exec` has no stated working directory.** Needs an eval scenario reproducing a concrete failure before it's worth code (see Non-goals).
2. **Model identity not restated across a provider/model switch mid-thread.** This repo's `resolveTurnModel`-per-turn + shared checkpointer architecture matches Anthropic's own stated failure precondition; needs an eval scenario to confirm before it's worth code (see Non-goals).
