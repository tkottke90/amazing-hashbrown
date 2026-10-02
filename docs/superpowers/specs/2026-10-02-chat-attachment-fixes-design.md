# Chat Attachment Fixes: Controlled Lifecycle, Vision Detection, Document Types — Design

**Date:** 2026-10-02
**Status:** Approved
**Issue:** [#251 — Bug - Chat attachments not delivered to model, vision misdetected](https://github.com/tkottke90/amazing-hashbrown/issues/251)

---

## 1. Problem

The chat attachment feature shipped in #125 (see
`docs/superpowers/specs/2026-09-02-chat-file-upload-design.md`) has three
independent gaps found in real use, all tracked under #251:

1. **The attachment chip never clears after send**, and a user can be left
   thinking a follow-up message still carries a file it doesn't.
   `ChatInput` (`ui/src/components/chat-input.tsx`) keeps its own private
   `stagedAttachment` signal for the chip, separate from the identically-named
   signal each parent (`chat/index.tsx`, `workspace-chat-tab.tsx`,
   `wiki/ingestion-chat.tsx`) keeps to pass `attachmentId` into
   `sendMessage`. The parent clears its own copy in `handleSend`; nothing
   ever clears `ChatInput`'s copy, which is what the chip actually renders
   from. The two signals are redundant, divergent sources of truth for the
   same concept — the text input doesn't have this problem because `value`/
   `onValueChange` is already a single controlled prop owned by the parent.
2. **Vision-capable models served by OpenAI-compatible backends are
   incorrectly blocked.** `resolveVisionCapabilityFromConfig`
   (`api/src/services/provider-factory.ts`) has a live capability check only
   for `ollama`-type providers (`client.show().capabilities`). Every other
   provider type falls through to `llm.profile?.imageInputs` (a static,
   per-package LangChain table that doesn't know about locally-hosted/custom
   model ids) and then an empty hand-maintained fallback table — so a model
   served by e.g. a Lemonade instance is always treated as non-vision, even
   when Lemonade's own `/models` response reports
   `"labels": ["custom", "vision", "tool-calling", "mtp"]` for it. This
   response comes back through the exact same OpenAI-compatible `/models`
   call `fetchModelIds` already makes — the data is already being fetched
   and discarded, not fetched from a separate endpoint.
3. **Only a narrow set of document types is accepted.** `classifyArtifact`
   (`api/src/artifacts/artifact-classifier.ts`) and the upload allow-list
   (`api/src/routes/v1/artifacts.handlers.ts`) only recognize
   `application/pdf`, the one DOCX MIME type, `text/plain`, and
   `text/markdown` — rejecting every other plain-text format (CSV, JSON,
   YAML, source files, etc.) with "Unsupported file type", even though they
   need no special processing to be read as text.

Separately, scope was expanded during design review to add observability
into the attachment pipeline: today, whether a file was uploaded, whether it
was actually handed to the model, or excluded (and why) leaves no record
anywhere a developer can inspect after the fact — only the live SSE stream
and the chip UI reflect it in the moment.

---

## 2. Scope

**In scope:**

- Converting `ChatInput`'s attachment handling from private state + change
  callback to a fully controlled prop, matching the existing `value`/
  `onValueChange` pattern.
- Reading the already-fetched OpenAI-compatible `/models` response's
  `labels` field (when present) to detect vision support, for `openai`-type
  providers, without adding new network calls to `GET /api/v1/providers`.
- Widening accepted document types to any `text/*` MIME type, plus
  `application/json` and a normalized `application/yaml`.
- A MIME-type resolution step that falls back to sniffing the file
  extension when the browser reports a generic/empty type (chiefly a
  problem for `.yaml`/`.yml`, which has no single universally-registered
  MIME type).
- Recording, in the Observability trace/span system, whether an attachment
  was included in or excluded from an LLM request on a given turn, and why.

**Explicitly out of scope:**

- A new Observability trace for the upload event itself (see §6.1) — the
  upload's on-disk location is already fully reconstructable from
  `ArtifactMeta` (persisted at upload time, per #125), and every existing
  trace source models an LLM invocation (`provider`/`model` are `NOT NULL`
  columns); stretching that schema to also model a standalone non-LLM event
  was weighed and declined in favor of using data that already exists.
- Any change to image handling, PDF/DOCX extraction, or the vision-gate
  decision logic itself (§6 of the original design) — only _what counts as
  vision-capable_ changes, not what happens once that's known.
- A generic, provider-agnostic "capabilities" abstraction. This only reads
  one known field (`labels`) from one known shape (OpenAI-compatible
  `/models` responses) that happens to appear in the wild (Lemonade) —
  inventing a general capability-discovery framework for other possible
  fields/servers is unneeded speculation (YAGNI) until a second concrete
  case shows up.
- Office/binary document formats beyond what #125 already covers (XLSX,
  PPTX, RTF, ODT, etc.) — those need real parsing, not a MIME-list change,
  and are a separate follow-up if wanted.
- Multiple attachments per message, attachments on HITL resume/retry turns
  — unchanged from the original design's scope.

---

## 3. Attachment Lifecycle: Controlled Component

`ChatInput`'s props change from an uncontrolled notify-only callback:

```typescript
onAttachmentChange?: (attachment: StagedAttachment | null) => void;
```

to a controlled pair, mirroring `value`/`onValueChange`:

```typescript
attachment: StagedAttachment | null;
onAttachmentChange: (attachment: StagedAttachment | null) => void;
```

- `ChatInput` deletes its internal `const stagedAttachment = useSignal<StagedAttachment | null>(null)` (`chat-input.tsx:195`) entirely. Every place that currently reads/writes it reads/writes the `attachment` prop and calls `onAttachmentChange` instead:
  - `stageFile` (`chat-input.tsx:200-224`) — reads `attachment` (the prop) instead of `stagedAttachment.value` for the "replace, don't accumulate" cleanup check; calls `onAttachmentChange(uploaded)` / `onAttachmentChange(null)` on success/failure instead of also assigning a local signal.
  - `handleRemoveAttachment` (`chat-input.tsx:233-244`) — same substitution.
  - `showVisionWarning`'s computation (`chat-input.tsx:267`, `!!stagedAttachment.value?.requiresVision`) reads `attachment?.requiresVision` instead.
  - The chip render (`chat-input.tsx:644-648`) reads `attachment` instead of `stagedAttachment.value`.
- `attachmentError` stays as `ChatInput`'s own internal signal — it's transient upload-failure UI state local to the component, not something any parent needs to observe or own, so it doesn't need to become controlled.
- Each of the 3 call sites already holds exactly the signal needed to satisfy the new `attachment` prop — no new state is introduced there, just one more prop passed down:

  ```tsx
  <ChatInput
    ...
    attachment={stagedAttachment.value}
    onAttachmentChange={(attachment) => {
      stagedAttachment.value = attachment;
    }}
  />
  ```

  (`chat/index.tsx`, `workspace-chat-tab.tsx`, `wiki/ingestion-chat.tsx` — identical pattern in all three today, confirmed by inspection.)

This closes both the reported bug and a related latent one for free: since the parent's `handleSend` already does `stagedAttachment.value = null` before calling `sendMessage` (`chat/index.tsx:48-50` and the equivalent in the other two files), the chip now correctly disappears the moment that happens — no new logic needed there. The same is true for a future thread switch, if a parent ever resets its own `stagedAttachment` signal on `activeThreadId` change.

---

## 4. Vision Detection for OpenAI-Compatible Providers

### 4.1 Reading capability labels

`provider-factory.ts` gains a function returning the raw `/models` entries
(not just ids) for providers whose `fetchModelIds` branch can reasonably
carry extra fields:

```typescript
export interface RawModelDetails {
  id: string;
  labels?: string[];
}

export async function fetchModelDetails(provider: ProviderConfig): Promise<RawModelDetails[]> {
  // openai-type only — same client.models.list() call fetchModelIds already
  // makes; duck-types whatever extra fields the server actually returned
  // (e.g. Lemonade's `labels`) rather than relying on the openai SDK's
  // narrower response typing to have declared them. Best-effort: swallows
  // any failure (network error, bad key, provider down) into an empty
  // array, same convention as listModels() above it — a provider's models
  // endpoint being unreachable degrades that provider to "no vision info",
  // not a broken /providers response.
}
```

`resolveVisionCapabilityFromConfig` gains an optional 3rd parameter:

```typescript
export async function resolveVisionCapabilityFromConfig(
  providerConfig: ProviderConfig,
  modelId: string,
  rawDetails?: RawModelDetails,
): Promise<boolean> {
  if (providerConfig.type === 'ollama') {
    /* unchanged */
  }

  try {
    const llm = createProviderFromConfig(providerConfig, modelId);
    return (
      llm.profile?.imageInputs ??
      rawDetails?.labels?.includes('vision') ??
      FALLBACK_VISION_CAPABILITIES[providerConfig.type][modelId] ??
      false
    );
  } catch {
    return false;
  }
}
```

When `rawDetails` is omitted, behavior is unchanged from today (falls
straight through to the fallback table) — this keeps
`resolveVisionCapability` (the per-turn, single-model lookup used by
`resolveAttachmentForTurn`) simple: it doesn't have a pre-fetched model list
to hand in, and it only ever needs one model's answer per attachment-bearing
send, so doing its own one-off `fetchModelDetails` call there (added inside
`resolveVisionCapability`, not `resolveVisionCapabilityFromConfig`, since
that's the real-env-resolving wrapper) is proportionate — no caching
infrastructure needed for a call that happens once per send.

### 4.2 Avoiding N× refetching in the model-picker endpoint

`GET /api/v1/providers` (`providers.route.ts:15-45`) currently calls
`resolveVisionCapabilityFromConfig(p, id)` once per model, inside a loop
over `liveIds` (itself already the result of one `listModels(p)` call). If
that function did its own fetch per call, an `openai`-type provider with N
models would re-fetch the _entire_ model list N times for one endpoint
response. Instead:

```typescript
const liveIds = await listModels(p);
const rawDetailsById =
  p.type === 'openai' ? new Map((await fetchModelDetails(p)).map((d) => [d.id, d])) : new Map();
// ...
const imageInput = await resolveVisionCapabilityFromConfig(p, id, rawDetailsById.get(id));
```

One `fetchModelDetails` call per `openai`-type provider per request, reused
across every model in that provider's list.

### 4.3 Why this is safe for other providers

`labels` is read via optional chaining off a duck-typed shape — real
OpenAI's and Anthropic's model-list responses never include it, so
`rawDetails?.labels?.includes('vision')` is `undefined` for them and the
existing `.profile`/fallback-table chain behaves exactly as it does today.
Ollama is untouched — it never reaches this branch.

---

## 5. Document Type Expansion

### 5.1 MIME resolution and normalization (`artifacts.handlers.ts`)

New helper, run before the existing `isAllowedMimeType` check:

```typescript
const EXTENSION_MIME_FALLBACK: Record<string, string> = {
  yaml: 'application/yaml',
  yml: 'application/yaml',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

// Browsers report YAML particularly inconsistently (application/x-yaml,
// text/yaml, text/x-yaml, or a generic/empty type depending on OS) since it
// has no single universally-registered MIME type — normalize every variant
// to one canonical value so everything downstream (classifyArtifact,
// the allow-list) only ever has to handle 'application/yaml'.
const YAML_MIME_ALIASES = new Set(['application/x-yaml', 'text/yaml', 'text/x-yaml']);

function resolveEffectiveMimeType(reportedMimeType: string, filename: string): string {
  if (YAML_MIME_ALIASES.has(reportedMimeType)) return 'application/yaml';

  if (reportedMimeType && reportedMimeType !== 'application/octet-stream') {
    return reportedMimeType;
  }

  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_MIME_FALLBACK[ext]) || reportedMimeType;
}
```

Called once, at the top of `uploadArtifactHandler`, before
`isAllowedMimeType(input.mimeType)` — the resolved value is what gets
validated, classified, and stored as the artifact's `mimeType` from that
point on (no separate "reported vs. effective" distinction persists past
this point).

### 5.2 Allow-list (`artifacts.handlers.ts`)

```typescript
const ALLOWED_NON_IMAGE_MIME_TYPES = new Set([
  'application/pdf',
  DOCX_MIME_TYPE,
  'application/json',
  'application/yaml',
]);

function isAllowedMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('text/') ||
    ALLOWED_NON_IMAGE_MIME_TYPES.has(mimeType)
  );
}
```

`text/*` being accepted wholesale, rather than enumerating
`text/plain`/`text/markdown`/`text/csv`/etc. individually, is deliberate per
the issue's stated deviation: nothing about being served as `text/*` implies
a format needs special parsing — it's always safe to decode as UTF-8.

### 5.3 Classification (`artifact-classifier.ts`)

```typescript
if (
  mimeType.startsWith('text/') ||
  mimeType === 'application/json' ||
  mimeType === 'application/yaml'
) {
  return { requiresVision: false, extractedText: buffer.toString('utf-8') };
}
```

replaces the existing exact-match branch:

```typescript
if (mimeType === 'text/plain' || mimeType === 'text/markdown') { ... }
```

No parsing or validation of JSON/YAML content — it's handed to the model as
raw text, same as every other plain-text type. Moved after the `image/*`
and `application/pdf` checks stay exactly where they are (unaffected).

### 5.4 Client-side picker hint (`ui/src/services/artifacts-api.ts`)

```typescript
export const ACCEPTED_ATTACHMENT_TYPES =
  'image/*,text/*,.pdf,.docx,.json,.yaml,.yml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json,application/yaml';
```

Still UX-only (per the existing comment on this constant) — the server-side
checks in §5.1–5.2 are the real gate, since a multipart upload can carry any
MIME type regardless of what the native picker's `accept` attribute
suggested.

---

## 6. Observability: Attachment Events

Three facts about an attachment's lifecycle should be inspectable after the
fact, not just visible live in the UI during the turn that produced them:
that a file was uploaded and where it lives on disk; that it was included in
a model request; and that it was excluded, with an explicit reason — not
just a bare boolean.

### 6.1 "Uploaded" — no new code needed

Observability's trace/span tables (`lib/observability/src/store.ts`) model
LLM invocations specifically: `observability_traces.provider` and `.model`
are `TEXT NOT NULL`, every `TraceSource` value wraps a model call, and
upload happens over a bare REST call (`POST /api/v1/artifacts`) before any
chat turn or trace exists. Forcing a standalone trace to exist for a
non-LLM event would mean migrating those columns to nullable and inventing
the concept of a traceless/model-less trace for the first time in this
codebase — a real schema change to serve one event type.

That data already exists without it: `ArtifactMeta` (`api/src/artifacts/artifact-store.ts`)
already persists `id`, `originalFilename`, and `threadId` at upload time,
per #125, and an artifact's on-disk location is always the deterministic
`path.join(artifactRoot, id, originalFilename)` — fully reconstructable
from fields already on disk in `meta.json`, for every upload, whether or
not it's ever sent. No code change is needed to satisfy this item.

### 6.2 "Included" / "Excluded" — new spans on the real turn trace

Unlike upload, these two events happen _inside_ an already-running chat
turn, which already gets a real trace via `startTurnObservability`
(`api/src/agents/turn-observability.ts`) — so they fit the existing model
directly, as a new span type on that trace, no schema migration required
(`observability_spans.type` is a plain `TEXT` column — `SpanTypeSchema` is
an application-level zod enum, not a DB constraint, so adding a value to it
needs no migration, unlike §6.1's hypothetical).

**`SpanTypeSchema`** (`lib/llm-common-types/src/traces/types.ts`) gains a
third value:

```typescript
export const SpanTypeSchema = z.enum(['llm-call', 'tool-call', 'attachment']);
```

**`UserMessageAttachment`** (`api/src/agents/thread-message-writer.ts`)
gains an optional reason, populated whenever `included` is `false` — today
it's only ever a bare boolean, which is exactly the gap item #3 of this
scope expansion calls out: knowing a file was excluded without knowing why
isn't enough to debug a report like #251's:

```typescript
export interface UserMessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  included: boolean;
  // Populated only when included is false. 'vision_unsupported': the
  // attachment required vision and the active model didn't support it.
  // 'artifact_missing': the artifact's metadata resolved but its bytes
  // were gone from disk (corrupted/missing state, stream-handler.ts's
  // existing fallback path).
  exclusionReason?: 'vision_unsupported' | 'artifact_missing';
}
```

`resolveAttachmentForTurn` (`stream-handler.ts:826-901`) sets
`exclusionReason` on both of its existing exclusion paths (`!visionGateOk`,
and the missing-artifact-bytes fallback) instead of just `included: false`
— this is also persisted into `thread_messages.payload.attachment` via the
existing `recordUserMessage` call, so the reason is available anywhere that
record already flows, not only in the new span.

**Recording the span**: `resolveAttachmentForTurn` already runs (and
`attachmentRecord` is already computed) _before_ `startTurnObservability`
creates the turn's `traceId` (`stream-handler.ts:963` vs. `:985`) — no
reordering needed, since nothing about resolving the attachment depends on
the trace existing. Once `turnObs.traceId` is available, if
`attachmentRecord` is present:

```typescript
if (attachmentRecord) {
  getObservabilityStore().saveSpans([
    {
      spanId: randomUUID(),
      traceId: turnObs.traceId,
      parentSpanId: null,
      type: 'attachment',
      name: attachmentRecord.included ? 'attachment-included' : 'attachment-excluded',
      startedAt: turnSentAt,
      endedAt: turnSentAt,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      inputPreview: null,
      outputPreview: JSON.stringify({
        artifactId: attachmentRecord.id,
        filename: attachmentRecord.filename,
        mimeType: attachmentRecord.mimeType,
        included: attachmentRecord.included,
        ...(attachmentRecord.exclusionReason
          ? { exclusionReason: attachmentRecord.exclusionReason }
          : {}),
      }),
      error: null,
    },
  ]);
}
```

`getObservabilityStore()` (`api/src/services/observability.ts`) is the same
singleton `startTurnObservability` itself calls internally — `saveSpans` is
a plain batch insert on the store, not something that has to go through
`ObservabilityCallbackHandler`'s LangChain-callback-driven lifecycle, so no
new plumbing is needed to call it directly here. The metadata goes in
`outputPreview` as a JSON string — the same convention `tool-call` spans
already use for structured data (`observability-handler.ts:143,157`), since
neither table has a dedicated metadata column.

Scoped to `streamChatToSse` only, matching where `resolveAttachmentForTurn`
is actually called today — `workspace-chat` and `wiki-ingestion` sends
don't currently route attachments through this function at all, which is a
pre-existing gap outside #251 and this scope expansion, not something this
change introduces or fixes.

---

## 7. Error Handling & Edge Cases

- **Generic/empty MIME type for an unrecognized extension** (e.g. a `.log`
  file reported as `application/octet-stream`): `resolveEffectiveMimeType`
  returns the original reported type unchanged (no fallback entry for that
  extension), so it's rejected by `isAllowedMimeType` exactly as before —
  this only adds recognition for the specific extensions listed in
  `EXTENSION_MIME_FALLBACK`, not a blanket "trust any extension" behavior.
- **A `rawDetails` lookup finds no matching id** (a model present in the
  provider's `defaultModel`/pricing config but absent from the live
  `/models` response — an existing possible state today):
  `rawDetailsById.get(id)` is `undefined`, `resolveVisionCapabilityFromConfig`
  receives `undefined` for `rawDetails`, and falls through to the fallback
  table exactly as it does today for non-`openai` providers.
- **`fetchModelDetails` fails** (network error, bad key): swallowed
  internally into an empty array (§4.1), matching `listModels`'s existing
  best-effort convention — a provider with an unreachable `/models` endpoint
  degrades to "no vision info for this provider" rather than breaking the
  whole `GET /api/v1/providers` response.
- **Attachment prop out of sync with a thread switch**: not newly
  introduced or newly fixed by this design beyond what §3 already resolves
  mechanically (whichever signal the parent clears, the chip now follows) —
  no parent currently resets `stagedAttachment` on `activeThreadId` change,
  and adding that reset is not required to close #251's reported symptoms,
  so it's left as-is rather than speculatively added.

---

## 8. Testing Plan

- **`ChatInput` (Jest, `ui/test/chat-input.test.tsx`)**: sending a message
  via the controlled `attachment` prop results in the parent's
  `onAttachmentChange(null)` being observable (asserting the chip disappears
  once the parent reflects that back down, same as any other controlled
  input) — covering the exact regression reported in #251. Existing tests
  for stage/remove/vision-warning behavior are updated to drive state via
  the prop instead of relying on the component's own signal.
- **`provider-factory.ts` (Mocha/Chai, `api/src/services/provider-factory.test.ts`)**:
  `resolveVisionCapabilityFromConfig` returns `true` when `rawDetails.labels`
  includes `'vision'`; returns the existing fallback-chain result when
  `rawDetails` is omitted or has no `labels`; Ollama and Anthropic paths are
  unaffected by the new parameter. `fetchModelDetails` correctly surfaces an
  extra field (e.g. `labels`) present on a mocked `/models` response.
- **`providers.route.ts` (orchestration, supertest)**: for an `openai`-type
  provider with N models, `fetchModelDetails` is called once (spy), not N
  times — verifying the interaction this design exists to avoid, not just
  the end result.
- **`artifact-classifier.ts` (Mocha/Chai)**: `classifyArtifact` returns
  `requiresVision: false` and the raw text for representative `text/*`
  types beyond the two previously supported (e.g. `text/csv`), plus
  `application/json` and `application/yaml`.
- **`stream-handler.ts` (Mocha/Chai)**: `resolveAttachmentForTurn` sets
  `exclusionReason: 'vision_unsupported'` when the vision gate fails, and
  `'artifact_missing'` when the artifact's bytes are gone, and leaves
  `exclusionReason` undefined on a successful inclusion — extending the
  existing `resolveAttachmentForTurn` describe block
  (`stream-handler.test.ts:1227`). An orchestration-level test on
  `streamChatToSse` spies `getObservabilityStore().saveSpans` and asserts an
  `'attachment'`-type span is recorded with the right `name` and
  `outputPreview` contents for both an included and an excluded attachment,
  and that no such span is recorded when `attachmentId` is absent.
- **`artifacts.handlers.ts` (Mocha/Chai)**: `resolveEffectiveMimeType` —
  each YAML alias normalizes to `application/yaml`; a generic/empty type
  with a recognized extension resolves via the fallback map; a generic type
  with an unrecognized extension passes through unchanged; an explicit,
  non-generic type is never overridden by the extension, even if they
  disagree.
- **E2E (Playwright, `@user-workflow`)**: attach a plain-text/JSON file,
  send a message, assert the chip is gone immediately after send and the
  model's reply reflects the file's content (closing the "model didn't
  receive the file" symptom end-to-end, not just at the unit level). Mock
  the model response per `e2e/AGENTS.md`'s SSE-mocking pattern rather than
  requiring a real LLM. A second scenario mocks a provider's `/models`
  response with a `labels: ['vision']` entry and asserts the vision warning
  does _not_ appear for that model.
