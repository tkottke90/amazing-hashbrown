# Chat Error Classification — Design

**Date:** 2026-09-08
**Status:** Approved
**Issue:** [#146 — Enhancement: Show specific error messages in chat thread history](https://github.com/tkottke90/amazing-hashbrown/issues/146)

---

## 1. Problem & Goal

Whenever a chat turn fails, the UI shows the same hardcoded text — "Something went wrong. Please try again." — regardless of cause. A provider billing/insufficient-funds error, an invalid API key, a context-length-exceeded error, or a content-policy rejection will all fail again on retry, but the user has no way to tell that apart from a genuinely transient failure.

A codebase audit found the backend already captures the raw failure text (`errorMessageOf(err)` → `thread_messages.payload.error`, via `failAssistant`) and sends it on the `stream_error` SSE event — but the frontend currently **discards it entirely**: `use-thread.ts`'s `stream_error` handler only sets `status: 'error'` and never reads `evt.error`. There is no classification of *what kind* of error occurred anywhere in the stack today — just an unused raw string.

Goal: classify a failed turn's error into a small set of user-facing categories (auth, billing, rate limit, context length, content policy, provider unavailable, network, unknown), persist and stream that classification alongside the existing raw message, and have the chat UI render category-specific copy (with the raw provider text available as expandable detail) instead of the generic fallback — on every chat surface, live and after reload. The retry action stays available in all cases; it no longer implies retrying will help.

---

## 2. Scope

**In scope:**

- A shared error-classification function covering the three configured providers (Anthropic, OpenAI, Ollama).
- Threading the classified category (plus the existing raw message) through `failAssistant`, the DB payload, the live `stream_error` SSE event, and thread reload.
- Updating `assistant-message.tsx` to render category-specific copy/icon with an expandable raw-detail toggle, in place of the hardcoded generic string.
- All four surfaces that already funnel a turn-ending error through `failAssistant`/`errorMessageOf`: global chat, workspace chat, wiki ingestion chat, and automated task runs (`task-execution.ts`).
- An Ollama-specific heuristic: an empty response (no content, no thought content, no tool call — including `ask_user`) is treated as a synthetic `context_length` failure, since Ollama can silently truncate/return nothing on context overflow rather than throwing.
- Fixing a pre-existing gap: `task-execution.ts`'s failure branch currently doesn't pass an error message to `failAssistant` at all, so a failed task run shows the generic text even before this change.

**Out of scope:**

- Any provider beyond Anthropic, OpenAI, and Ollama (none others are currently configurable in this codebase).
- Changing retry mechanics/UI beyond what's needed to keep it available regardless of category (issue #41 owns the retry mechanism itself).
- The Thread Report template (`lib/thread-reports`) — it already renders `payload.error` as free text; adding category display there is a natural follow-up but not required by this issue.
- Applying the empty-response heuristic to Anthropic/OpenAI — both throw explicit, classifiable errors on context overflow, so the heuristic is Ollama-only.

---

## 3. Error Categories

```ts
type ChatErrorCategory =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'context_length'
  | 'content_policy'
  | 'unavailable'
  | 'network'
  | 'unknown';
```

`content_policy` is included even though the issue's Expected-Behavior bullet list only names the other six as a *minimum* — the issue's own Description cites a content-policy rejection as a motivating example of a non-retryable failure, so it gets the same treatment.

`unknown` is the fallback for anything unrecognized (including pre-existing persisted rows from before this change, which have no `errorCategory` at all) — it renders exactly today's generic text, so nothing regresses for old data.

### Category → user-facing copy

| Category | Message |
|---|---|
| `auth` | "Authentication failed — check that your API key for this provider is valid." |
| `billing` | "This provider account is out of credit or has a billing issue. Retrying won't help until that's resolved." |
| `rate_limit` | "The provider is rate-limiting requests. Wait a bit before retrying." |
| `context_length` | "This conversation is too long for the model's context window. Try starting a new thread or shortening it." |
| `content_policy` | "The provider declined this request for policy reasons. Rephrasing may help; retrying as-is won't." |
| `unavailable` | "The model or provider is temporarily unavailable. This is usually transient — retrying may work." |
| `network` | "Couldn't reach the provider — check your connection." |
| `unknown` | "Something went wrong. Please try again." |

When a raw provider message is available, it's shown underneath the category sentence behind a "Show details" toggle, never in place of it.

### Classification rules

Checked in order; first match wins; anything unmatched falls to `unknown`.

**Shared network check (all providers, runs first):** Node connection-error codes (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`) or fetch-level connection failures → `network`.

**Anthropic** (`@anthropic-ai/sdk` errors via `@langchain/anthropic`):

| Signal | Category |
|---|---|
| `status === 401` | `auth` |
| `status === 400` and message matches `/credit balance\|insufficient/i` | `billing` |
| `status === 400` and message matches `/prompt is too long\|maximum context\|context length/i` | `context_length` |
| `status === 400` and message indicates a content-policy rejection | `content_policy` |
| `status === 429` | `rate_limit` |
| `status === 529` (overloaded) or `status >= 500` | `unavailable` |
| anything else | `unknown` |

**OpenAI** (`openai` SDK errors via `@langchain/openai`):

| Signal | Category |
|---|---|
| `status === 401` | `auth` |
| `status === 429` and `error.code === 'insufficient_quota'` | `billing` |
| `status === 429` (otherwise) | `rate_limit` |
| `status === 400` and `error.code === 'context_length_exceeded'` | `context_length` |
| `status === 400` and `error.code === 'content_policy_violation'` | `content_policy` |
| `status >= 500` | `unavailable` |
| anything else | `unknown` |

**Ollama** (`@langchain/ollama`, local HTTP server): auth/billing/rate-limit don't apply.

| Signal | Category |
|---|---|
| connection refused/timeout | `network` (via shared check) |
| "model not found" response | `unavailable` |
| empty response: `content === ''`, `thoughtContent === ''`, and no tool call (including `ask_user`) occurred during the turn | `context_length` (see §4) |
| anything else | `unknown` |

Exact message substrings/error-class checks will be pinned against the real `@anthropic-ai/sdk`/`openai` types during implementation (dependencies aren't installed in this design pass); tests will construct real SDK error instances rather than hand-rolled objects, per this repo's external-boundary testing convention.

---

## 4. Architecture

### 4a. Classifier module

New `api/src/agents/error-classification.ts`:

```ts
function classifyChatError(err: unknown, provider?: string): { category: ChatErrorCategory; message: string };
```

Dispatches by `provider` to `classifyAnthropicError` / `classifyOpenAIError` / `classifyOllamaError`, each matching that SDK's real error shape (status + nested `error.type`/`error.code` + message substrings where there's no dedicated code). A shared network-error check runs first regardless of provider. Never throws — any unrecognized shape (including non-`Error` thrown values) resolves to `{ category: 'unknown', message: String(err) }`.

### 4b. Threading the category through existing failure paths

All four surfaces (`stream-handler.ts`, `workspace-chat-stream-handler.ts`, `wiki-stream-handler.ts`, `task-execution.ts`) already funnel a turn-ending error through `errorMessageOf(err)` → `failAssistant(...)`. This becomes `classifyChatError(err, resolvedProvider)`, and `failAssistant` (in `thread-message-writer.ts`) gains one more optional parameter, `errorCategory?: ChatErrorCategory`, stored as `payload.errorCategory` alongside the existing `payload.error`. `task-execution.ts`'s failure branch, which currently omits the message entirely, is brought up to parity with the other three.

### 4c. Getting the category to the live SSE stream

Today, the turn's own `catch` block calls `failAssistant` then `throw err`; it's the *outer* route handler (`chat.route.ts`, `workspace-chat.route.ts`, `wiki.route.ts`) that actually emits the `stream_error` SSE event, via `String(err)` — one level removed from where classification happens and where `resolvedProvider` is known. Rather than re-derive the provider at the route layer, the inner catch rethrows a small `ClassifiedTurnError extends Error` (same pattern this file already uses for `PipeEventsError`) carrying `{ message, category }`, computed once. The outer route catch reads `.category` off it (falling back to `'unknown'` for any other thrown shape) and includes it on the SSE event.

### 4d. Shared type contract

`lib/llm-common-types/src/chat/sse-events.ts` — already the single source of truth both API and UI import from (see `HitlKind`) — gains:

- `ChatErrorCategorySchema` / `ChatErrorCategory`, exported from the package.
- `StreamErrorSchema` gains an optional `errorCategory: ChatErrorCategorySchema.optional()` field.

### 4e. Ollama empty-response heuristic

`pipeEvents` (in `stream-handler.ts`) already observes every `on_tool_start` event; it gains a returned `hadToolCall: boolean` (true if any tool call fired during the turn, `ask_user` included — a HITL-only turn with empty text is a legitimate outcome, not a failure).

The check lives in `finalizeTurn` itself (every call site already funnels through it) rather than duplicated per call site: at the top, before the normal `finalizeAssistant`/interrupt-check flow, if `provider === 'ollama' && content.trim() === '' && thoughtContent.trim() === '' && !hadToolCall`, it calls `failAssistant(..., <context_length copy>, 'context_length')` instead of `finalizeAssistant`, and returns a `failed: true` flag (alongside the existing `interrupted` flag) so callers emit `stream_error` instead of `stream_done`.

This is a best-effort heuristic, not a certainty — documented as such, not treated as guaranteed-accurate detection. It's scoped to Ollama only; Anthropic and OpenAI both throw explicit, classifiable errors on context overflow instead of returning silently.

### 4f. Reload path

`GET /threads/:id`'s `toClientMessage` (`threads.handlers.ts`) already spreads the full `payload` object onto the client message verbatim, so `payload.errorCategory` flows through on reload with no route change — only the UI's `ThreadMessage` type needs the field declared.

### 4g. UI

`ui/src/types/thread-message.ts`'s `assistant` variant gains `error?: string; errorCategory?: ChatErrorCategory;`.

`use-thread.ts`'s `stream_error` handler currently only sets `status: 'error'`, dropping `evt.error`; it's updated to copy both `evt.error` and `evt.errorCategory` onto the message. The three client-side catches that synthesize a local `stream_error` event when a fetch/SSE connection itself throws (`sendMessage`, `submitHitlAnswer`, `retryTurn`) default `errorCategory: 'network'`, since that path only fires on a genuine connection failure that never reached the server.

`assistant-message.tsx`: the hardcoded `<span>Something went wrong. Please try again.</span>` block is replaced by a new presentational component, `ChatErrorDetail`, composed in the same spot:

- A category → `{ icon, label }` lookup (lucide-preact, already a dependency): `KeyRound` (auth), `CreditCard` (billing), `Timer` (rate_limit), `FileWarning` (context_length), `ShieldAlert` (content_policy), `CloudOff` (unavailable), `WifiOff` (network), `AlertTriangle` (unknown — matching the icon already used for "Response interrupted").
- Primary line: icon + the category's fixed copy sentence from §3.
- If `message.error` is present, a "Show details" toggle (reusing `ThoughtBlock`'s `useSignal`-based expand/collapse pattern) reveals the raw provider text.
- No category (older rows, or true `unknown`) → today's generic sentence, no details toggle.
- Retry stays shown whenever `isError && !isSuperseded && onRetry`, unchanged, regardless of category — per the issue's explicit requirement that retry's presence no longer implies it will help.

---

## 5. Testing Plan

- **Unit — `error-classification.ts`:** table-driven tests per provider, constructed from real SDK error classes (`Anthropic.APIError`/`OpenAI.APIError` subclasses) rather than hand-rolled objects. Covers every row in §3's tables, plus unmatched/malformed errors and non-`Error` thrown values.
- **Unit — `thread-message-writer.test.ts`:** extend `failAssistant` tests for `errorCategory` persistence, and confirm it's omitted (not persisted) when not provided.
- **Orchestration — `stream-handler.test.ts`:** a thrown classified error surfaces `errorCategory` on the `stream_error` SSE event via `ClassifiedTurnError`; `finalizeTurn` with `provider: 'ollama'`, empty content/thought, `hadToolCall: false` fails with `context_length` and signals `failed: true`; the inverse case (a tool call happened) still finalizes normally. Equivalent `hadToolCall` cases added to `workspace-chat-stream-handler.test.ts` and `wiki-stream-handler.test.ts`. `task-execution.ts` gets a case confirming a failed task run now persists `errorCategory`.
- **Unit — `ui/test/assistant-message.test.tsx`:** one case per category for copy/icon; "Show details" toggle reveals `message.error`; a persisted row with no `errorCategory` falls back to today's generic text with no toggle; Retry renders regardless of category.
- **E2E — `e2e/tests/turn-retry.spec.ts`:** already mocks a `stream_error` event for the retry-after-error flow; extend with a couple of `@functional` cases mocking specific `errorCategory` values (e.g. `billing`, `context_length`) asserting the right message renders end-to-end. Full per-category coverage lives in the unit tests; E2E just proves the wiring.

---

## 6. Files Changed (expected)

- `api/src/agents/error-classification.ts` (new) + test
- `api/src/agents/thread-message-writer.ts` (`failAssistant` signature) + test
- `api/src/agents/stream-handler.ts` (`ClassifiedTurnError`, `pipeEvents`'s `hadToolCall`, `finalizeTurn`'s empty-response check, all catch blocks) + test
- `api/src/agents/workspace-chat-stream-handler.ts` (mirrors stream-handler.ts's changes) + test
- `api/src/agents/wiki-stream-handler.ts` (mirrors stream-handler.ts's changes) + test
- `api/src/agents/task-execution.ts` (pass classified message/category to `failAssistant`) + test
- `api/src/routes/v1/chat.route.ts`, `workspace-chat.route.ts`, `wiki.route.ts` (read `.category` off `ClassifiedTurnError` for the `stream_error` SSE event)
- `lib/llm-common-types/src/chat/sse-events.ts` (`ChatErrorCategorySchema`, `StreamErrorSchema` field)
- `ui/src/types/thread-message.ts` (`error`/`errorCategory` fields)
- `ui/src/hooks/use-thread.ts` (`stream_error` handler, client-side catch defaults)
- `ui/src/components/assistant-message.tsx` (`ChatErrorDetail` component) + test
- `e2e/tests/turn-retry.spec.ts` (additional category cases)

---

## 7. Out of Scope / Follow-ups

- Thread Report (`lib/thread-reports`) rendering `errorCategory` alongside the existing raw `error` text — natural follow-up, not required here.
- Any provider beyond Anthropic/OpenAI/Ollama.
- Changing what retry *does* per category (e.g. disabling it for `auth`/`billing`) — the issue explicitly keeps retry available in all cases.
