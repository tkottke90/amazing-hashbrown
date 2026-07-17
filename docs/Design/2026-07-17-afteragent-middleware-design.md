# AfterAgent Middleware Design

**Date:** 2026-07-17
**Status:** Draft
**Related:** [`TODO_LIST.md`](../../TODO_LIST.md), [`docs/Design/2026-07-15-evaluation-harness-design.md`](./2026-07-15-evaluation-harness-design.md)

## Purpose

Design the background post-response layer that inspects each conversational chat turn for novel knowledge and writes it into the wiki knowledge base, without blocking or slowing the user's HTTP response. This is the next outstanding item on `TODO_LIST.md` and closes the conversational wiki-write loop opened by "Connect LLM-Wiki to Chat Agent."

## Background

TODO_LIST.md's next outstanding item is **AfterAgent Middleware**: a background post-response layer that inspects each conversational chat turn (Thread Type 1 — `POST /api/v1/chat/:threadId`) for novel knowledge and, if found, writes it into the wiki knowledge base without blocking or slowing the user's HTTP response. Its only dependency, "Connect LLM-Wiki to Chat Agent," is already done (`wiki_search`/`wiki_read_page` tools exist, read-only). This middleware is intentionally **the only write path into the wiki for conversational chat** — the wiki stays read-only during a turn itself.

This was fully brainstormed with the user first. Key decisions locked in during that process:

- **Signal mechanism**: heuristic post-hoc LLM classification, not a new agent tool.
- **Pipeline**: four focused structured-output LLM calls — summarize (rolling, always) → classify (always) → extract (if novel) → merge (if an existing wiki page matches). 2 calls in the common no-op case, up to 4 when writing.
- **Hook point**: a real LangChain `afterAgent` middleware hook (not a plain fire-and-forget function), which requires migrating `chat-agent.ts` off the deprecated `createReactAgent` onto `createAgent` (from the `langchain` package, v1.5.2, already installed).
- **Delivery of `wiki_updated` SSE events**: in-memory per-thread queue, drained and emitted as the first event(s) of the thread's _next_ turn (the schema/UI side of this is already built and unused — see `lib/llm-common-types/src/chat/sse-events.ts`'s `WikiUpdatedSchema` and `ui/src/hooks/use-thread.ts`).
- **Toggles**: a global `env.afterAgent.enabled` config flag AND a per-request `afterAgent?: boolean` body field; both must be true for the pipeline to run.
- **Observability**: the pipeline gets its own trace (separate from the turn's chat trace), reusing one `ObservabilityCallbackHandler` across all 2-4 calls — which requires fixing a latent bug in the handler (it never clears its span buffer after saving, so reusing one handler across multiple independent `.invoke()` calls would re-save already-persisted spans and hit a primary-key conflict).
- **Provenance**: pages written by AfterAgent save a raw source snapshot of the conversation turn via `wiki.saveRawSource()`, with the `threadId` recorded in `sourceUrl` (as `conversation:<threadId>`) so every written page traces back to the conversation that produced it.

A dedicated Plan agent then explored the actual repo (correcting two assumptions from the brainstorm: the test runner is **Mocha + Chai**, not vitest, per `api/.mocharc.json`; and the example config file is `api/config.yaml.example`, not `config/config.yaml.example`) and found one real bug the brainstorm missed: the extract step must not be allowed to produce `type: 'index'` or `type: 'log'`, because `llm-wiki`'s `TYPE_DIR` maps those to the wiki root, colliding with the wiki's real `index.md`/`log.md` files.

---

## Implementation Order

The riskiest change is the `createReactAgent` → `createAgent` migration, since it's on the path of every existing chat/HITL request. Do it first, in isolation, verified working, before writing any AfterAgent-specific code.

**Phase A — Migration only (no new behavior)**

1. `api/src/agents/chat-agent.ts`: `createReactAgent` → `createAgent` (from `langchain`, not `@langchain/langgraph/prebuilt`). Rename `llm`→`model`, `checkpointSaver`→`checkpointer` (no alias exists on `createAgent` — must rename). No middleware yet.
2. `api/src/agents/stream-handler.ts`: `emitHitlOrDone`'s `agent.getState(config)` → `agent.graph.getState(config)` (the `createAgent`-returned object's `.getState()` is typed `never`/internal; `.graph.getState()` is the sanctioned public path, same runtime behavior).
3. Manually verify: a plain chat turn streams correctly; HITL (`ask_user`) still pauses/resumes; MCP tool calls still stream `tool_call_start`/`tool_call_end`; observability spans still record for a single turn. `npm run test --workspace api` and `npm run build --workspace api` should both pass unchanged (existing `chat-agent.test.ts` only exercises `mcpToolToLangChain`/`invalidateChatAgent`, neither touching `createAgent` internals).

**Phase B — Observability bugfix** (independent, low blast radius, required before the pipeline can reuse one handler across calls) 4. `api/src/agents/observability-handler.ts`: clear `this.completed` after `saveSpans()` in `handleChainEnd`; add `runName` (8th param of `handleLLMStart`) as a preferred override of the derived span name. 5. `api/src/agents/observability-handler.test.ts` (new — none exists today): unit tests for both fixes against a fake store. 6. Manually re-verify a single chat turn still produces exactly one trace with correct spans.

**Phase C — Config plumbing** 7. `api/src/config/env.ts`: new `AfterAgentSchema` + `env.afterAgent` getter (mirrors `ObservabilitySchema`/`env.observability` exactly). 8. `api/config.yaml.example`: document the new `afterAgent: { enabled: true }` section.

**Phase D — The pipeline module itself** (new file, not wired in yet — typecheckable and partially unit-testable in isolation) 9. `api/src/agents/after-agent.ts` (new) — see full shape below. 10. Unit tests for the LLM-independent pieces (transcript-slicing helper, pending-events map mechanics).

**Phase E — Evaluation coverage** (new; depends on Phase D's `buildXPrompt` functions existing; must land before Phase F wires the pipeline into live traffic — verify the prompts behave as intended before they're exposed to real chat turns) 11. Extend `lib/evaluations` with the `structured` scenario type — schema (`StructuredScenarioSchema`, `StructuredDetails`), executor (`executors/structured.ts`), and `runner.ts`'s new branch/`invokeStructuredModel` helper. This part has no dependency on Phase D and could technically be done earlier, but is sequenced here to keep all eval work together (see the "Evaluation Coverage" section below for full detail). 12. Write `suites/after-agent.yaml` — the 16 classify/extract/summarize/merge scenarios (see "Evaluation Coverage" below), using literal rendered prompt text copied from `after-agent.ts`'s `buildXPrompt` functions (this part _does_ depend on Phase D). 13. Run `npm run eval -- --suite after-agent --model <provider/model>` against a baseline model and review results.

**Phase F — Wire the middleware in** 14. `chat-agent.ts`: add the `afterAgent` middleware via `createMiddleware(...)`, pass into `createAgent({ middleware: [...] })`. 15. `stream-handler.ts`: pass `context: { provider, model, afterAgentEnabled }` (a sibling key to `configurable`, not nested in it) into both `streamEvents()` calls; drain+emit pending `wiki_updated` events at the very start of `streamChatToSse`/`resumeChatToSse`, before the new turn's own events. 16. `chat.route.ts`: accept `afterAgent?: boolean` in both routes' request bodies, thread through positionally.

**Phase G — Manual end-to-end verification** (see below — this is what actually proves the feature works; LLM output quality isn't unit-testable)

**Phase H — Docs** 17. Move "AfterAgent Middleware" from Outstanding to the end of Completed Items in `TODO_LIST.md`, matching the existing one-line summary style; leave the `### AfterAgent Middleware` prose section under "Item Details" untouched (matches how other completed items keep their original requirements prose).

---

## File-by-File Changes

### `api/src/agents/chat-agent.ts`

- Import `createAgent`, `createMiddleware` from `langchain` (not `@langchain/langgraph/prebuilt`); keep `MemorySaver` from `@langchain/langgraph`.
- Import `getAfterAgentContextSchema`, `runAfterAgentPipeline` from `./after-agent.js`.
- Build `afterAgentMiddleware` via `createMiddleware({ name: 'AfterAgentMiddleware', contextSchema: getAfterAgentContextSchema(), afterAgent: (state, runtime) => {...} })`. The handler reads `runtime.configurable?.thread_id` and `runtime.context` (provider/model/afterAgentEnabled), then does `void runAfterAgentPipeline({...}).catch(err => logger.error(...))` and returns immediately (must not `await` the pipeline — the framework awaits the hook itself before the graph reaches `END`).
- `buildChatAgent` returns `createAgent({ model: llm, tools: [...], checkpointer, middleware: [afterAgentMiddleware] })` instead of `createReactAgent({ llm, tools, checkpointSaver })`.
- `ChatAgent` type alias, `getChatAgent`/`_agents` cache, `invalidateChatAgent` all stay as-is (derived types, no shape change needed). Note: the middleware instance is baked into each cached per-`provider:model` agent, but reads per-invocation context fresh from `streamEvents()` each call — no state leakage between requests sharing a cached agent.

### `api/src/agents/after-agent.ts` (new)

```ts
import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import { createProvider } from '../services/provider-factory.js';
import { getWikiRegistry } from '../services/wiki.js';
import { getObservabilityStore } from '../services/observability.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
```

No runtime import from `stream-handler.ts` (avoids a circular import) — `stream-handler.ts` instead imports `drainPendingWikiUpdates` from here.

**Per-thread state** (in-memory, unbounded — consistent with the existing `_agents` cache and `artifact-store.ts` Map precedent; real eviction is deferred to the already-planned "Persistent Conversation Memory" item):

```ts
const threadState = new Map<string, { rollingSummary: string }>();

interface WikiUpdatedEvent {
  type: 'wiki_updated';
  pageTitle: string;
  pageKind: string;
  wikiName: string;
}
const pendingWikiUpdates = new Map<string, WikiUpdatedEvent[]>();

export function drainPendingWikiUpdates(threadId: string): WikiUpdatedEvent[] {
  const events = pendingWikiUpdates.get(threadId) ?? [];
  pendingWikiUpdates.delete(threadId);
  return events;
}
```

**Context schema** (consumed by the middleware in `chat-agent.ts`; give every field a default so `context` is optional at the `streamEvents()` call site):

```ts
const AfterAgentContextSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  afterAgentEnabled: z.boolean().optional(),
});
export function getAfterAgentContextSchema() {
  return AfterAgentContextSchema;
}
```

**Pipeline step schemas:**

```ts
const SummarizeOutputSchema = z.object({ summary: z.string() });
const ClassifyOutputSchema = z.object({ shouldWrite: z.boolean(), reason: z.string() });
// 'index'/'log' deliberately excluded — llm-wiki's TYPE_DIR maps both to the
// wiki root, colliding with the wiki's real index.md/log.md files.
const ExtractOutputSchema = z.object({
  domainId: z.string(),
  type: z.enum(['entity', 'concept', 'comparison', 'query', 'summary']),
  title: z.string(),
  tags: z.array(z.string()),
  body: z.string(),
  summary: z.string().optional(),
});
const MergeOutputSchema = z.object({ body: z.string() });
```

**Orchestrator:**

```ts
export interface RunAfterAgentPipelineParams {
  threadId: string;
  messages: BaseMessage[];
  provider?: string;
  model?: string;
  requestAfterAgentEnabled?: boolean;
}

export async function runAfterAgentPipeline(params: RunAfterAgentPipelineParams): Promise<void> {
  const { threadId, messages, provider, model, requestAfterAgentEnabled } = params;

  if (!env.afterAgent.enabled) return; // global kill switch wins
  if (requestAfterAgentEnabled === false) return;

  const turnText = extractLatestTurnText(messages);
  if (!turnText.trim()) return;

  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: model ?? '',
  });
  const handler = new ObservabilityCallbackHandler(
    traceId,
    store,
    env.observability.spanOutputPreviewChars,
  );

  try {
    const llm = createProvider(provider, model);
    const state = threadState.get(threadId) ?? { rollingSummary: '' };

    const { summary } = await invokeStructured(
      llm,
      SummarizeOutputSchema,
      buildSummarizePrompt(state.rollingSummary, turnText),
      handler,
      'after-agent:summarize',
    );
    state.rollingSummary = summary;
    threadState.set(threadId, state);

    const classify = await invokeStructured(
      llm,
      ClassifyOutputSchema,
      buildClassifyPrompt(turnText, state.rollingSummary),
      handler,
      'after-agent:classify',
    );
    if (!classify.shouldWrite) return;

    const registry = await getWikiRegistry();
    const domains = registry.list();
    if (domains.length === 0) {
      logger.warn('after-agent: no wiki domains registered', { threadId });
      return;
    }

    const extract = await invokeStructured(
      llm,
      ExtractOutputSchema,
      buildExtractPrompt(turnText, state.rollingSummary, domains),
      handler,
      'after-agent:extract',
    );
    const domainEntry = domains.find((d) => d.id === extract.domainId);
    if (!domainEntry) {
      logger.warn('after-agent: unknown domainId from extract — skipping', {
        threadId,
        domainId: extract.domainId,
      });
      return;
    }

    const wiki = await registry.load(domainEntry.id);
    const prep = await wiki.ingestPrep({ content: extract.body, keywords: extract.tags });

    // Provenance: always save a raw snapshot of the turn, tagged with threadId.
    const rawSource = await wiki.saveRawSource({
      content: turnText,
      sourceUrl: `conversation:${threadId}`,
      path: prep.suggestedRawPath,
      sha256: prep.sha256,
    });

    let finalBody = extract.body;
    let relPath: string | undefined;
    if (prep.existingPages.length > 0) {
      relPath = prep.existingPages[0];
      const existingPage = await wiki.readPage(relPath);
      const merged = await invokeStructured(
        llm,
        MergeOutputSchema,
        buildMergePrompt(existingPage.content, extract.body),
        handler,
        'after-agent:merge-page',
      );
      finalBody = merged.body;
    }

    const commitResult = await wiki.commitPage({
      type: extract.type,
      title: extract.title,
      tags: extract.tags,
      sources: [rawSource.path],
      body: finalBody,
      summary: extract.summary,
      relPath,
    });

    const events = pendingWikiUpdates.get(threadId) ?? [];
    events.push({
      type: 'wiki_updated',
      pageTitle: extract.title,
      pageKind: extract.type,
      wikiName: domainEntry.id,
    });
    pendingWikiUpdates.set(threadId, events);

    logger.info('after-agent: wrote wiki page', {
      threadId,
      path: commitResult.path,
      created: commitResult.created,
    });
  } catch (err) {
    logger.error('after-agent: pipeline error', { threadId, err }); // never throw back into the hook
  } finally {
    store.endTrace(traceId, { totalTokens: handler.totalInputTokens + handler.totalOutputTokens });
  }
}
```

**Helpers** (`extractLatestTurnText` exported for unit testing; the rest internal):

```ts
export function extractLatestTurnText(messages: BaseMessage[]): string {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].getType() === 'human') {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx === -1) return '';
  return messages
    .slice(lastHumanIdx)
    .map((m) => `${m.getType()}: ${stringifyContent(m.content)}`)
    .join('\n');
}

function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => ('text' in block ? block.text : `[${block.type ?? 'non-text content'}]`))
    .join(' ');
}

async function invokeStructured<T extends z.ZodTypeAny>(
  llm: ReturnType<typeof createProvider>,
  schema: T,
  prompt: string,
  handler: ObservabilityCallbackHandler,
  runName: string,
): Promise<z.infer<T>> {
  return llm
    .withStructuredOutput(schema)
    .withRetry({ stopAfterAttempt: 3 })
    .invoke(prompt, { callbacks: [handler], runName });
}

function buildSummarizePrompt(priorSummary: string, turnText: string): string {
  /* template-literal prompt, house style per lib/evaluations/src/executors/llm-judge.ts */
}
function buildClassifyPrompt(turnText: string, summary: string): string {
  /* ... */
}
function buildExtractPrompt(
  turnText: string,
  summary: string,
  domains: ReturnType<import('@tkottke90/llm-wiki').WikiRegistry['list']>,
): string {
  /* ... */
}
function buildMergePrompt(existingBody: string, newBody: string): string {
  /* ... */
}
```

### `api/src/agents/stream-handler.ts`

- `emitHitlOrDone`: `agent.getState` → `agent.graph.getState`.
- `streamChatToSse` and `resumeChatToSse` each gain a trailing `afterAgent?: boolean` parameter. At the top of each, before building `eventStream`: drain and emit pending events —
  ```ts
  for (const event of drainPendingWikiUpdates(threadId)) writeSseEvent(res, event);
  ```
- Both `streamEvents(...)` calls gain a `context` option alongside `configurable`:
  ```ts
  context: { provider: provider ?? env.defaultProvider, model: model ?? '', afterAgentEnabled: afterAgent ?? true },
  ```

### `api/src/routes/v1/chat.route.ts`

- `POST /:threadId`: destructure `afterAgent?: boolean` from body, pass as the new trailing arg to `streamChatToSse(res, threadId, content.trim(), startedAt, provider, model, afterAgent)`.
- `POST /:threadId/hitl`: same for `resumeChatToSse`.
- No new validation — optional boolean, defaults to `true` inside `stream-handler.ts` when `undefined`.

### `api/src/agents/observability-handler.ts`

- `handleChainEnd`: add `this.completed.length = 0;` after `this.store.saveSpans(this.completed)`.
- `handleLLMStart`: accept 8th param `runName?: string`; span `name` becomes `runName ?? derivedName` (derived name logic unchanged as fallback). `handleToolStart` untouched.

### `api/src/agents/observability-handler.test.ts` (new)

Mocha/Chai, no mocking library (matches repo convention — see `api/src/services/provider-factory.test.ts`). Build a minimal fake store (`{ saveSpans: (spans) => calls.push(spans) } as unknown as ObservabilityStore`). Cover:

- Two sequential `handleLLMStart`/`handleLLMEnd` pairs each followed by `handleChainEnd()` save disjoint span sets (regression test for the buffer-clear fix).
- `runName` passed to `handleLLMStart` produces a span with that name, not the derived model id.
- Omitting `runName` still falls back to the derived name (no regression).

### `api/src/agents/after-agent.test.ts` (new)

Unit tests for `extractLatestTurnText` (pure, no LLM dependency): finds the last human message correctly, includes everything after it, excludes prior turns, returns `''` for no-human-message input. Also basic `drainPendingWikiUpdates` map-mechanics (returns `[]` for an unknown thread, doesn't throw on repeated drains).

### `api/src/config/env.ts`

```ts
const AfterAgentSchema = z.object({ enabled: z.boolean().default(true) });
// in AppConfigSchema: afterAgent: AfterAgentSchema.optional(),
get afterAgent(): z.infer<typeof AfterAgentSchema> {
  try {
    return (configManager as any).getSection('afterAgent', AfterAgentSchema) as z.infer<typeof AfterAgentSchema>;
  } catch { return AfterAgentSchema.parse({}); }
},
```

(Exact mirror of `ObservabilitySchema`/`env.observability` — no dedicated unit test, consistent with the existing convention that none of the `getSection`-based getters have one.)

### `api/config.yaml.example`

Add, after the `observability:` section:

```yaml
# ---------------------------------------------------------------------------
# AfterAgent Middleware
#
# Background post-response layer that inspects each conversational turn for
# novel knowledge and writes it into the wiki. Runs after the turn's SSE
# stream completes; never blocks or slows the user-facing response.
# ---------------------------------------------------------------------------
afterAgent:
  enabled: true
```

### `TODO_LIST.md`

Move item 1 ("AfterAgent Middleware") from Outstanding to the end of Completed Items (item 11), renumber the remaining Outstanding entries, one-line summary in the established style, e.g.:

> `[AfterAgent Middleware](#afteragent-middleware) — heuristic post-hoc LLM pipeline (summarize → classify → extract → merge) fires as a createAgent afterAgent middleware hook; writes go through ingestPrep/commitPage with raw-source provenance; wiki_updated SSE events queue per-thread and flush at the start of the next turn`

Leave the `### AfterAgent Middleware` prose section under "Item Details" untouched.

---

## Phase E — Evaluation Coverage

Sequenced between Phase D (the pipeline module, which defines the `buildXPrompt` functions these scenarios reuse) and Phase F (wiring the middleware into live chat traffic) — the intent is eval-driven verification: confirm the pipeline's prompts behave as intended against a baseline model _before_ they're exposed to real users. This phase covers both the AfterAgent pipeline's individual prompts and its agent-level behavior, using the existing Evaluation Harness (`lib/evaluations`, a completed TODO item). Research surfaced two real gaps in that harness that this phase must address:

1. **No structured-output scenario type.** Every existing scenario type (`deterministic`, `semantic`, `llm-judge`, `human`) invokes a plain `model.invoke(input)` and coerces the response to a string (`ScenarioResultSchema.actualOutput: z.string()`). AfterAgent's `classify`/`extract` prompts produce structured JSON (`{shouldWrite, reason}`, `{domainId, type, title, tags, body}`) via `.withStructuredOutput()` — there's no existing way to score that natively. **Decision: extend the harness with a new `structured` scenario type** rather than working around it with stringified-JSON regex/judge scenarios.
2. **`POST /api/v1/evaluations/run` doesn't exist**, despite TODO_LIST.md marking it "completed" (only the `lib/evaluations` package, SQLite store, and `npm run eval` CLI actually shipped — the evaluation-harness design doc itself correctly scoped the API route as deferred, so this is a `TODO_LIST.md` phrasing inaccuracy rather than a missed spec). **Decision: don't build it now** — out of scope for this feature. Run the new suite via the existing `npm run eval` CLI (`bin/eval.ts`), same as `wiki-search`.

### `lib/evaluations` changes (new scenario type)

**`lib/evaluations/src/schemas.ts`:**

- New `StructuredScenarioSchema = BaseScenario.extend({ type: z.literal('structured'), outputSchema: z.record(z.unknown()), fieldChecks: z.array(z.object({ path: z.string(), match: z.enum(['equals', 'contains', 'exists', 'oneOf']), value: z.unknown().optional() })).min(1), minScore: z.number().min(0).max(1).default(1) })`. `path` is a dot-path into the parsed structured object (e.g. `'shouldWrite'`, `'tags'`); `minScore` is the fraction of `fieldChecks` that must pass for the scenario to pass. `oneOf` checks the resolved value is a member of `value` (an array) — added specifically for "field must be one of these allowed enum values" checks (see `ext-005` below).
- Add `StructuredScenarioSchema` to the `ScenarioSchema` discriminated union.
- New `StructuredDetails = z.object({ type: z.literal('structured'), fieldResults: z.array(z.object({ path: z.string(), match: z.string(), expected: z.unknown(), actual: z.unknown(), passed: z.boolean() })), score: z.number() })`, added to `ScenarioResultDetailsSchema`'s union.
- `ScenarioResultSchema.actualOutput` stays `z.string()` unchanged — structured results store `JSON.stringify(parsedOutput)` there, keeping the result schema/store untouched.
- Export `StructuredScenario` type.

**`lib/evaluations/src/executors/structured.ts` (new):** `runStructured(scenario: StructuredScenario, parsedOutput: unknown): StructuredDetails` — resolves each `fieldChecks[].path` against `parsedOutput` (simple dot-path resolver, no array-index syntax needed for this feature's use case), applies `equals`/`contains`/`exists`/`oneOf`, computes `score = passedCount / fieldChecks.length`. Mirrors the existing `executors/deterministic.ts` file structure/style.

**`lib/evaluations/src/runner.ts`:**

- New `invokeStructuredModel(model: BaseChatModel, input: string, outputSchema: Record<string, unknown>): Promise<{ parsed: unknown; content: string; latencyMs: number }>` calling `model.withStructuredOutput(outputSchema).invoke(input)`. **Implementation risk to verify early**: confirm the installed `@langchain/core`'s `withStructuredOutput()` accepts a raw JSON-Schema-shaped `Record<string, unknown>` (not just a Zod schema) — LangChain's structured-output API generally supports both, but this must be confirmed against the actual installed version before scenarios can declare `outputSchema` inline in YAML. If raw JSON Schema isn't accepted, fall back to a small internal registry mapping known `outputSchema` names (e.g. `'after-agent-classify'`) to real Zod schemas defined in code, referenced from YAML by name instead of inline shape.
- New branch in `executeScenario` for `scenario.type === 'structured'`: call `invokeStructuredModel`, run `runStructured`, set `actualOutput: JSON.stringify(parsed)`, `passed: details.score >= scenario.minScore`, `score: details.score`.

**Tests:** extend `lib/evaluations/test/unit/schemas.test.ts` for the new schema; add `lib/evaluations/test/unit/executors/structured.test.ts` (mirroring existing executor test conventions) for the field-check logic (equals/contains/exists/oneOf, partial pass scoring).

### `suites/after-agent.yaml` (new)

Mirrors `suites/wiki-search.yaml`'s structure (`suite: {id, name, purpose, passingThreshold}` + `scenarios: [...]`). Each scenario's `input` field must ultimately be the fully-rendered prompt string produced by `after-agent.ts`'s `buildClassifyPrompt`/`buildExtractPrompt`/`buildSummarizePrompt`/`buildMergePrompt` for the fixture arguments shown below — write these fixtures now, fill in the literal rendered `input` text once Phase D lands (its `buildXPrompt` functions must exist first — see the Sequencing note below). This creates a maintenance coupling (prompt template changes require updating fixtures by hand); accepted for v1, no automated fixture generation.

**Agent-level scenario scoping decision**: the harness's `runEval` invokes a bare `BaseChatModel`, not the full `createAgent` graph/tool-execution loop, and has no mechanism to assert on side effects (actual wiki file writes) via the real `POST /api/v1/chat/:threadId` route. True end-to-end HTTP-level agent evals are therefore **out of scope for this suite** — "agent api" coverage means scenarios exercise the same prompts/model configuration the AfterAgent pipeline actually uses, not the live Express endpoint.

#### Classify scenarios (`type: structured`, `outputSchema` = the classify step's JSON schema)

| id                                 | fixture (rolling summary + turn text)                                                                                                         | fieldChecks                | why                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cls-001-novel-personal-fact`      | summary: `""`; turn: _"My favorite programming language is Rust and I work at Acme Corp as a backend engineer."_                              | `shouldWrite equals true`  | Baseline positive case — unambiguous novel personal facts.                                                                                     |
| `cls-002-smalltalk-no-write`       | summary: `""`; turn: _"Thanks, that's really helpful!"_                                                                                       | `shouldWrite equals false` | Baseline negative case — no factual content at all.                                                                                            |
| `cls-003-question-not-statement`   | summary: `""`; turn: _"What's the weather like on Mars?"_ / agent answers with general astronomy facts                                        | `shouldWrite equals false` | Guards against treating every informative agent answer as wiki-worthy — general knowledge the agent recites isn't novel info _about the user_. |
| `cls-004-correction-of-prior-fact` | summary: _"User's favorite language is Python."_; turn: _"Actually, I misspoke earlier — my favorite language is actually Rust, not Python."_ | `shouldWrite equals true`  | Corrections to previously-recorded facts must still trigger a write (feeds the merge/contradiction-resolution path).                           |
| `cls-005-already-known-repeat`     | summary: _"User works at Acme Corp as a backend engineer."_; turn: _"Yeah, I still work at Acme Corp."_                                       | `shouldWrite equals false` | Tests that classify actually uses the rolling summary to detect redundancy rather than flagging every mention of a known fact.                 |

#### Extract scenarios (`type: structured`, `outputSchema` = the extract step's JSON schema; fixture domains default to `[{id: 'user', tags: ['personal'], routingNotes: 'user preferences, personal context, and biography'}]` unless noted)

| id                                    | fixture                                                                                                                                                                                                                                                               | fieldChecks                                                                     | why                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ext-001-entity-fact-basic`           | turn: _"I work at Acme Corp as a backend engineer."_                                                                                                                                                                                                                  | `domainId equals 'user'`; `type equals 'entity'`; `tags exists`; `title exists` | Baseline entity extraction shape.                                                                                                                                                                                                                                                                                                                                               |
| `ext-002-concept-explanation`         | turn: _"GraphQL is a query language for APIs that lets clients request exactly the data they need, unlike REST's fixed endpoints."_                                                                                                                                   | `type equals 'concept'`                                                         | Confirms the model distinguishes conceptual explanations from entity facts.                                                                                                                                                                                                                                                                                                     |
| `ext-003-comparison-content`          | turn: _"Rust and Go both compile to native binaries, but Rust has no garbage collector while Go does."_                                                                                                                                                               | `type equals 'comparison'`                                                      | Confirms `comparison` is chosen when the content is explicitly contrastive.                                                                                                                                                                                                                                                                                                     |
| `ext-004-domain-routing-multi-domain` | domains: `[{id: 'user', routingNotes: 'personal context and biography'}, {id: 'projects', routingNotes: 'work projects, deploy pipelines, and engineering systems'}]`; turn: _"The Phoenix project's deploy pipeline runs on GitHub Actions and deploys to AWS ECS."_ | `domainId equals 'projects'`                                                    | Confirms domain routing actually uses the routing notes to pick among multiple registered domains, not just defaulting to the first/only one.                                                                                                                                                                                                                                   |
| `ext-005-never-index-or-log`          | turn: _"Here's a log of everything that happened today: I fixed three bugs and had two meetings."_ (deliberately log-flavored phrasing)                                                                                                                               | `type oneOf ['entity', 'concept', 'comparison', 'query', 'summary']`            | Regression check for the `index`/`log` path-collision bug (see Phase A) — the primary safeguard is that `outputSchema` itself excludes `index`/`log` at the structured-output binding level, so this scenario's real purpose is confirming the model still produces a valid, sensible type for log-flavored input rather than erroring or being coerced into an excluded value. |

#### Summarize scenarios (`type: llm-judge`, judged over the JSON-stringified `{summary}` output — `llm-judge` interpolates `actualOutput` as raw text regardless of shape, so no harness change is needed for this pair)

| id                              | fixture                                                                                                                                          | rubric focus                                                                                                                                                      | why                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `sum-001-first-turn-no-prior`   | prior summary: `""`; turn: _"I just moved to Seattle for a new job at a fintech startup."_                                                       | Summary must mention Seattle and the fintech startup job; must not be empty or generic.                                                                           | Baseline cold-start summarization.                                                                   |
| `sum-002-rolling-fold-in`       | prior summary: _"User lives in Seattle and works at a fintech startup called Northwind Finance."_; turn: _"I just adopted a dog named Biscuit."_ | Summary must retain the Seattle/Northwind Finance facts **and** mention the new dog Biscuit — no dropped information.                                             | Core rolling-summary correctness — this is the single most important property of the summarize step. |
| `sum-003-summary-stays-concise` | prior summary: a ~300-word summary covering 5+ distinct facts; turn: a trivial aside (_"by the way it's raining today"_)                         | Summary should remain reasonably concise (not dramatically longer than the input), retain the important prior facts, and not over-elaborate on the trivial aside. | Guards against unbounded summary growth over a long-running thread.                                  |

#### Merge scenarios (`type: llm-judge`, judged over the JSON-stringified `{body}` output)

| id                                 | fixture                                                                                                                                                                                        | rubric focus                                                                                                                                     | why                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mrg-001-complementary-facts`      | existing body: _"Acme Corp is where the user works as a backend engineer."_; new body: _"Acme Corp is a fintech company founded in 2015, and the user's team works on the payments platform."_ | Merged body must contain both the "backend engineer" fact and the "fintech company founded in 2015"/"payments platform" facts.                   | Baseline additive merge — no information loss.                                                                                                   |
| `mrg-002-contradiction-resolution` | existing body: _"The user's favorite language is Python."_; new body: _"The user says their favorite language is actually Rust, not Python — they corrected themselves."_                      | Merged body must reflect Rust as the current favorite, not present Python and Rust as equally true — a brief note that it changed is acceptable. | Directly exercises the `cls-004` correction case through to a correct merged result — the two scenarios together cover the full correction flow. |
| `mrg-003-no-duplication`           | existing body: _"The user works at Acme Corp as a backend engineer."_; new body: _"The user works at Acme Corp as a backend engineer, and also mentioned enjoying rock climbing."_             | Merged body must not repeat the "works at Acme Corp" sentence verbatim twice; the rock climbing fact should be incorporated once.                | Guards against naive concatenation instead of a real merge.                                                                                      |

`passingThreshold`: start at `0.75` (matches `wiki-search.yaml`'s convention) — revisit once a baseline model's real pass rate is observed.

Run via `npm run eval -- --suite after-agent --model <provider/model>` (existing CLI, no new script needed).

### Sequencing

The `lib/evaluations` schema/runner/executor changes have no dependency on Phase D and could technically be done alongside Phases A-C, but are kept together with the suite work in this single phase for clarity. The `suites/after-agent.yaml` scenario fixtures genuinely do depend on Phase D — write the fixture table now (done above), fill in the literal rendered `input` prompt text once `after-agent.ts`'s `buildXPrompt` functions exist. This whole phase must complete — including a passing `npm run eval` run — before Phase F wires the pipeline into live chat traffic.

---

## Testing Strategy

**Unit-testable (Mocha/Chai):**

- `observability-handler.test.ts` — buffer-clear fix, `runName` preference (both pure logic against a fake store).
- `after-agent.test.ts` — `extractLatestTurnText`, `drainPendingWikiUpdates` map mechanics.

**Not reasonably unit-testable — requires manual verification (Phase G):**
LLM output quality (summarize/classify/extract/merge correctness), the full `createMiddleware` wiring against a real `createAgent`/`streamEvents()` call, cross-request timing of the `wiki_updated` queue, HITL interaction with `afterAgent` (per LangChain's contract, it does not fire on a turn that pauses via `interrupt()`, only once a turn — including a resumed HITL turn — actually completes), and the observability trace-per-pipeline-run behavior.

**Manual verification plan** (run against a live Ollama instance, `afterAgent.enabled: true`):

1. Send a message with clearly novel info ("My favorite language is Rust and I work at Acme Corp"). Confirm the HTTP response completes normally and promptly — the pipeline must not add response latency.
2. Check `GET /api/v1/traces` for a second trace on the thread (distinct from the chat trace) with spans named `after-agent:summarize`, `after-agent:classify`, `after-agent:extract` (and `:merge-page` if applicable).
3. Inspect the wiki root for a newly created/updated page with correct frontmatter, and a new raw source file under `raw/` whose `source_url` is `conversation:<threadId>`.
4. Send a second message in the same thread — confirm the SSE stream's first event(s) are `wiki_updated`, rendered by the existing `WikiUpdateMessage` UI component before the new turn's own `text_delta` events.
5. Send a low-content message ("thanks!") — confirm only 2 spans (summarize+classify), no wiki write.
6. Repeat step 1 with `afterAgent: false` in the request body — confirm no pipeline trace/write despite global config being enabled.
7. Set `afterAgent.enabled: false` globally, retry with `afterAgent: true` in the body — confirm the global kill switch wins.
8. Start a HITL (`ask_user`) flow — confirm no premature wiki write before resuming; confirm the write happens after the resumed turn completes.
9. Send several turns with incremental facts about the same entity — confirm the merge/update path kicks in on turns 2/3 instead of creating duplicate pages, and `commitPage`'s source-merging/`created`-date preservation behaves as expected.

## Known Deferred Items (flagged, not blocking)

- Per-thread state maps (`threadState`, `pendingWikiUpdates`) are unbounded/in-memory, consistent with the existing `_agents` cache and `artifact-store.ts` precedent; real eviction is deferred to the already-planned "Persistent Conversation Memory" TODO item.
- `wiki_updated`'s `wikiName` field uses the domain's registry `id` (e.g. `"user"`) since `WikiEntry` has no persisted human-readable display name — serviceable for v1 chip rendering, revisit if a friendlier name is wanted later.
