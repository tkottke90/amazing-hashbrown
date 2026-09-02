# Chat File Upload & Attachment Capability Gating — Design

**Date:** 2026-09-02
**Status:** Approved
**Issue:** [#125 — Enhancement - Add file attachment support to chat input](https://github.com/tkottke90/amazing-hashbrown/issues/125)

---

## 1. Problem

`ChatInput` (`ui/src/components/chat-input.tsx`) already renders an "Add file" menu item wired to an `onAddFile` prop, but no consumer of the component ever supplies that prop — clicking it is a no-op. There is no drag-and-drop support either. Users have no way to attach a file to a chat message, in either of the surfaces `ChatInput` backs (`ui/src/pages/workspaces/[id].tsx`'s main chat, and `ui/src/pages/wiki/ingestion-chat.tsx`'s wiki-ingestion chat).

Two concrete use cases motivate this:

1. **Image review / prompt refinement.** A user generates an image externally (Midjourney, ComfyUI, etc.) and wants the agent to look at it and help refine the generation prompt. Requires the agent to actually receive image content, which requires a vision-capable model.
2. **Document import into the wiki.** A user has a doc/notes file (PDF, docx, txt, md) they want ingested into the wiki without pasting its contents into chat as raw text.

The two use cases have different needs — one requires vision, the other just needs text extraction — which is why the model-capability gating below is central to this design, not an afterthought.

Most of the storage-layer plumbing for this already exists but has never been wired to a UI: `api/src/artifacts/artifact-store.ts`'s `ArtifactOrigin` type already includes `'user-upload'` (and `storeArtifact` already defaults to it), and `POST /api/v1/artifacts` already accepts a multipart upload and stores it. What's missing is everything that turns that into a usable chat feature: the UI to select/drop a file, the model-capability data needed to know whether an attachment can actually be used, the message-construction changes to hand it to the agent, and the history rendering to show what was attached.

---

## 2. Scope

**In scope (v1):**

- Images (any `image/*` the active model's provider accepts) and PDF/DOCX/TXT/MD documents.
- One attachment per message.
- Both the "Add file" button and drag-and-drop onto `ChatInput`.
- A capability check that prevents sending vision-only content to a model that doesn't support it, surfaced as a non-blocking warning in the composer.
- Explicit removal of a staged, not-yet-sent attachment (with server-side deletion).
- Message-history rendering of what was attached and whether the model actually received it.
- Garbage collection of orphaned uploads — a file uploaded then abandoned without being sent or explicitly removed (e.g. the browser tab is closed mid-flow). Covered in §5.3.

**Explicitly out of scope (v1):**

- Multiple attachments per message.
- OCR fallback for vision-only content on non-vision models — such content is excluded from the message, not degraded into an OCR text summary (decided explicitly: simpler behavior, matches the original ask of "don't try to send it").
- Attachments on HITL resume (`resumeChatToSse`) or retry (`retryChatToSse`) turns — attachment handling is scoped to the initial message send. A retry re-runs an already-persisted turn, which already recorded whatever attachment decision was made the first time.
- Click-to-open/download an attachment thumbnail in message history (visual indicator only in v1).
- Audio/video attachments, and any file type outside the allow-list in §5.1.

---

## 3. Architecture Overview

```
 ┌─────────────┐  select/drop file   ┌──────────────────────────┐
 │  ChatInput  │ ───────────────────▶│ POST /api/v1/artifacts    │
 │  (button or │                      │ (existing route, extended)│
 │  drag-drop) │                      └──────────────┬────────────┘
 └─────────────┘                                     │ classify + extract, once
        ▲                                             ▼
        │ chip renders                    ArtifactMeta gains:
        │ (filename, remove,               requiresVision: boolean
        │  warning icon if needed)         extractedText?: string
        │                                             │
        └─────────────────────────────────────────────┘
        │
        ├── user removes chip ──▶ DELETE /api/v1/artifacts/:id
        │
        └── user sends ──▶ POST /api/v1/chat/:threadId { content, attachmentId }
                                         │
                                         ▼
                          re-read ArtifactMeta (no reclassification)
                          requiresVision && !activeModel.imageInput?
                            → exclude; persist attachment.included = false
                            → else: build LangChain content (image block,
                              or extractedText merged into the message text)
```

Classification and text extraction happen **once, at upload time**, not at send time. This is what makes the explicit-delete requirement and the vision-gate both cheap: both read a fact already computed and stored on `ArtifactMeta`, rather than re-processing the file.

---

## 4. Backend: Model Capability Plumbing

`GET /api/v1/providers` (`api/src/routes/v1/providers.route.ts`) is extended: for each model it already lists, it additionally resolves an `imageInput: boolean` via a new `resolveVisionCapability(providerName, modelId)` in `provider-factory.ts`, dispatched by provider type — **not a single uniform lookup**, corrected from an earlier draft of this section after verifying the actual installed LangChain packages:

```typescript
// Ollama: live query, mirroring the existing listEmbeddingModels() pattern
// in provider-factory.ts (per-model client.show(), 'embedding' → 'vision').
const info = await client.show({ model: modelName });
const imageInput = info.capabilities?.includes('vision') ?? false;

// OpenAI/Anthropic: LangChain's beta ModelProfile, wrapped in try/catch
// (ChatAnthropic's constructor throws synchronously with no resolvable
// apiKey — a lookup loop must not let that break the whole response).
const llm = createProvider(p.name, id);
const imageInput = llm.profile?.imageInputs ?? FALLBACK_VISION_CAPABILITIES[p.type]?.[id] ?? false;
```

- **Why two mechanisms, not one:** LangChain's `.profile` (`@langchain/core@1.2.2`'s real `ModelProfile` TS interface — camelCase, e.g. `imageInputs`, not the Python TypedDict's `image_inputs` an earlier draft of this doc cited) is a hardcoded, per-package static table for `ChatOpenAI`/`ChatAnthropic`, keyed by exact model-id strings. `ChatOllama` never overrides `.profile` at all — the base class's stub always returns `{}`. Since this repo's default and only-enabled-by-default provider (`config.yaml.example`) is Ollama, relying on `.profile` alone would show the warning badge on every Ollama model, always, including real vision models. Ollama's own `/api/show` endpoint already exposes an authoritative `capabilities` array — this codebase already queries it today for `'embedding'` detection (`listEmbeddingModels()`), so the identical live-query pattern, checking for `'vision'` instead, is the correct mechanism for Ollama specifically.
- `FALLBACK_VISION_CAPABILITIES` is a small hardcoded table (provider type → model id → `boolean`) for OpenAI/Anthropic models `.profile` doesn't cover. Starts empty/minimal — entries are added only as specific gaps are actually found, not pre-populated speculatively. Not used for Ollama, which always has the live check.
- **Default when nothing is known: `false` (unsupported).** Given the requirement not to send unsupported content, an unknown model is treated conservatively rather than optimistically — a false negative (unnecessary warning) is a minor annoyance; a false positive (silently failed send) is worse.

`ModelInfo` (`ui/src/hooks/use-providers.ts`) gains `imageInput?: boolean`, populated straight from this response. No other capability flags (`pdf_inputs`, `audio_inputs`, etc.) are surfaced — out of scope, since nothing in this design needs them.

---

## 5. Backend: Artifact Upload, Classification, and Delete

### 5.1 Upload (`POST /api/v1/artifacts`, extended)

The existing multer-based route (`api/src/routes/v1/artifacts.route.ts`, 25MB limit, memory storage) gains:

- **Server-side MIME allow-list**: `image/*` (whatever the existing `processImage` pipeline already handles), `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), `text/plain`, `text/markdown`. Anything else → `400`. The client's file-picker `accept` attribute is a UX nicety, not the real gate — multipart uploads can carry any MIME type regardless of what the picker suggested.
- **Real filename capture.** `ArtifactMeta.originalFilename` is currently synthesized as `original.<ext-from-mimetype>` (`artifact-store.ts:97`), discarding the browser-supplied name entirely. This is fixed to store multer's `req.file.originalname` as a new `displayFilename` field (kept separate from the existing `originalFilename`, which stays the on-disk filename derived from MIME type — no change to how files are written to disk, just an added field for UI display).
- **Classification and extraction, once:**
  - `image/*` → `requiresVision: true`. No text extraction.
  - `application/pdf` → attempt text-layer extraction (new dependency: `pdf-parse`). Text found → `requiresVision: false`, extracted text stored. No text found (scanned/image-only PDF) → `requiresVision: true`.
  - docx (new dependency: `mammoth`) → `requiresVision: false`, text always extracted.
  - `text/plain`, `text/markdown` → `requiresVision: false`, content read directly as UTF-8 text (no library needed).
- `ArtifactMeta` gains `requiresVision: boolean`, `hasExtractedText: boolean`, and `referencedAt: string | null` (set in §6 once the artifact is actually used in a sent message; `null` means "still just staged, or truly orphaned" — this is what §5.3's GC sweep keys off). `hasExtractedText` mirrors the existing `hasVariants` boolean — the actual text is never put on `ArtifactMeta`/`meta.json` itself; it's stored as a sibling file (`text.txt`) in the artifact's directory (same pattern as `web.webp`/`preview.jpg`) and read on demand via a new `getExtractedText(id)` accessor.
- Response body gains `requiresVision` and `displayFilename` so the client can render the chip and decide the warning immediately after upload, with no extra round trip.

### 5.2 Delete (`DELETE /api/v1/artifacts/:id`, new)

Follows the existing delete-route convention in this codebase (`tasks.route.ts`, `threads.route.ts`, `workspaces.route.ts`). Backed by a new shared primitive, `deleteArtifact(id)` in `artifact-store.ts`, so this route and §5.3's GC sweep share one implementation of the origin guard rather than duplicating it:

- Looks up `ArtifactMeta`; `404` if missing.
- Only permits deletion when `meta.origin === 'user-upload'` — this can never delete an `'agent-generated'` artifact (e.g. one `upload_image` created), regardless of who calls it.
- Removes the artifact's directory and its in-memory index entry.
- Called by the frontend only when the user removes a **staged, unsent** attachment chip. Once a message has been sent referencing an artifact, nothing in this design deletes it — it needs to persist so message history (§8) can keep rendering it after the fact. (This is also exactly why §6 sets `referencedAt` on send — so §5.3's sweep knows not to touch it.)

### 5.3 Garbage collection of orphaned uploads (new)

An artifact is **orphaned** when it's `origin === 'user-upload'`, `referencedAt === null` (never made it into a sent message), and the user didn't explicitly remove it either — the tab was closed, the browser crashed, or the compose was simply abandoned mid-flow. Nothing else in this design cleans these up, so without this they accumulate on disk indefinitely.

There's no existing periodic-sweep pattern anywhere in this codebase to extend (`task-scheduler.ts`'s `TaskScheduler` is event-driven, not a timer sweep, and solves a different problem), so this introduces a small new one deliberately kept minimal — no new dependency, just a `setInterval`, consistent with this codebase's general preference for hand-rolled simplicity:

- New module `api/src/artifacts/artifact-gc.ts`, exporting `sweepOrphanedArtifacts(now: Date = new Date())`, injectable `now` for deterministic tests (same style as the `execFileFn`-injection pattern used elsewhere in this codebase for testability). Scans the in-memory index for `origin === 'user-upload' && referencedAt === null && createdAt` older than a grace period, and calls the same `deleteArtifact(id)` primitive as §5.2 for each match.
- **Grace period: 24 hours**, configurable (`env.artifactGc?.graceMs`, following the existing `env.agent?.recursionLimit ?? 100` optional-config convention). Long enough that a user who steps away mid-compose for a few hours doesn't lose their staged upload; short enough that abandoned files don't linger.
- **Sweep interval: 1 hour**, configurable (`env.artifactGc?.intervalMs`) — a separate knob from the grace period, since how often to check and how old something must be before it's eligible are different concerns.
- Started once at boot, alongside `bootArtifactStore()` (same server-bootstrap file), running one sweep immediately on boot — to catch orphans that accumulated while the process was down — and then on the configured interval.
- Scoped to `origin === 'user-upload'` only. `'agent-generated'` artifacts (e.g. from `upload_image`) are never touched — they're referenced inline in the assistant's own message content immediately on creation, a different lifecycle this GC has no opinion on.

---

## 6. Backend: Chat Message Construction

`streamChatToSse` (`api/src/agents/stream-handler.ts:547`) currently builds `agent.streamEvents({ messages: [{ role: 'human', content }] }, ...)` with `content` always a plain string (line 610-611). It's extended to accept an optional `attachmentId` (new parameter, threaded from `chatRouter.post('/:threadId', ...)`'s request body in `chat.route.ts`):

```typescript
if (attachmentId) {
  const meta = getArtifactMeta(attachmentId);
  const modelSupportsVision = /* resolve imageInput for effectiveProvider/effectiveModel, same lookup as §4 */;

  if (meta.requiresVision && !modelSupportsVision) {
    included = false; // excluded — not attached to the LangChain message at all
  } else if (meta.mimeType.startsWith('image/')) {
    content = [
      { type: 'text', text: content },
      { type: 'image', source_type: 'base64', data: <base64 of artifact original>, mime_type: meta.mimeType },
    ];
    included = true;
  } else {
    const text = await getExtractedText(attachmentId); // reads the sibling text.txt on demand
    content = `${content}\n\n---\nAttached file "${meta.displayFilename}":\n${text}`;
    included = true;
  }
}
```

- The `included` outcome (and `attachmentId`/`displayFilename`/`mimeType`) is passed into `recordUserMessage` (`thread-message-writer.ts`) so it's persisted on the `thread_messages` row's JSON `payload` — no new SQL column needed, `payload` is already a JSON blob.
- Whenever `attachmentId` is present, `ArtifactMeta.referencedAt` is stamped (via a small `markArtifactReferenced(id)` in `artifact-store.ts`) right after `recordUserMessage` succeeds — **regardless of `included`**. An excluded attachment was still legitimately used and resolved by the user's send, not abandoned; it must not be swept by §5.3's GC.
- Scoped to `streamChatToSse` only — not `resumeChatToSse` or `retryChatToSse` (§2).

---

## 7. Frontend: ChatInput

`chat-input.tsx` wires the existing `onAddFile` prop and adds a drag-and-drop handler on the same component, both converging on one "stage a file" path:

1. File selected (native picker, `accept` scoped to the allow-list in §5.1) or dropped → immediately `POST /api/v1/artifacts` (with the active `threadId`).
2. On success, a `ChatInputChip` (already supports `onRemove` — no change needed there) renders in the `header` slot showing `displayFilename`. `onRemove` calls `DELETE /api/v1/artifacts/:id`.
3. **Warning badge.** Rendered next to the `activeModel` chip (`chat-input.tsx:359`, existing `data-slot="model-chip"` span) whenever a staged attachment has `requiresVision === true` and the active model's `imageInput !== true`:
   - A `rounded-full` container with `bg-destructive/10` background (the existing desaturated-destructive pattern already used by the `destructive` button variant), sized to sit inline with the model-chip text (e.g. `size-4` container around a `size-3` icon).
   - Icon: lucide-preact's `AlertTriangle`, `text-destructive`.
   - Tooltip on hover, naming the active model and explaining it doesn't support image input.
   - **Does not block send.** Submission proceeds normally; the backend (§6) is what actually excludes the content.
4. A new shared Tooltip primitive is added at `ui/src/components/ui/tooltip.tsx`, wrapping the `radix-ui` package's Tooltip (already a dependency, currently unused — the rest of this codebase only uses native `title=""`). This is a real, reusable primitive rather than a one-off, matching the pattern `ui/src/components/ui/dropdown-menu.tsx` already follows for consuming the same `radix-ui` package.

---

## 8. Frontend: Message History

`ThreadMessage`'s `kind: 'user'` variant (`ui/src/types/thread-message.ts`) gains:

```typescript
attachment?: {
  id: string;
  filename: string; // displayFilename from §5.1
  mimeType: string;
  included: boolean;
};
```

Two independent pieces of UI consume this, deliberately decoupled — one always shows *what* was attached, the other shows *whether the model got it*:

1. **Attachment preview**, rendered inside the message body (`chat-message.tsx`'s `chat-message-body` region), regardless of `included`:
   - Image (`mimeType.startsWith('image/')`) → a boxed `<img>` thumbnail sourced from the existing `GET /api/v1/artifacts/:id` (the `web` WebP variant), constrained via CSS (e.g. `size-24 object-cover rounded-md`) — no new image-size variant needed.
   - Non-image → a colored box (`size-24 rounded-md`, extension text centered), color keyed by extension, following the raw-Tailwind-palette convention already used in `card-badge.tsx`: PDF `bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400`, DOCX `bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400`, MD `bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400`, TXT `bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400`. Proposed defaults, not final visual QA — easy to adjust in review.
   - Not interactive in v1 — no click-to-open/download.
2. **"Attachments Not Processed" action**, rendered only when `attachment.included === false`: a new `ChatMessageAttachmentWarningAction`, sibling to the existing `ChatMessageCopyAction`/`ChatMessageForkAction` (`chat-message.tsx`), passed into the `actions` prop in `thread-message.tsx`'s `case 'user'` branch. `AlertTriangle` icon, styled `text-amber-700 dark:text-amber-400` (the same raw-amber convention as `card-badge.tsx` — deliberately **not** `text-destructive`, since this is a retrospective fact about a past turn, not a live blocking warning). Tooltip: "Attachments Not Processed". Static — no click behavior, so it doesn't read as an actionable button next to the two real ones beside it.

---

## 9. Error Handling & Edge Cases

- **Unsupported file type at upload**: `400` from the server-side allow-list check (§5.1); the client shows an inline error near the chip location rather than staging a chip that will only be excluded later.
- **Upload failure (network, size limit)**: existing multer error-shaping in `artifacts.route.ts` already returns a consistent JSON error; the client surfaces it without staging a chip.
- **Delete failure**: if `DELETE` fails (network error, artifact already gone), the client removes the chip locally anyway rather than blocking the user — a failed explicit delete just leaves the artifact orphaned, which §5.3's GC sweep will clean up after the grace period regardless.
- **Model switched after staging, before send**: the warning badge re-evaluates against `activeModel` reactively (it's already computed from props on every render) — switching to a vision-capable model clears the warning without re-uploading.
- **Attachment referenced by a deleted/expired thread**: out of scope; artifacts are never cascade-deleted with their thread today (no existing behavior to preserve or change).

---

## 10. Testing Plan

- **Backend unit tests**: `uploadArtifactHandler` classification branches (image / text-bearing PDF / scanned PDF / docx / txt / md / rejected type); the new delete handler's origin guard (`user-upload` vs `agent-generated`); the vision-gate branch in the chat-send path (included vs excluded, for both cases against a `.profile`-known model and a fallback-table model); `sweepOrphanedArtifacts` with an injected `now` — an artifact just under the grace period survives, one just over it is deleted, a `referencedAt`-stamped one survives regardless of age, and an `'agent-generated'` artifact is never touched.
- **Backend integration tests**: full `POST /api/v1/artifacts` → `POST /api/v1/chat/:threadId` round trip for an image against a vision model (included) and a non-vision model (excluded), asserting the persisted `thread_messages` payload's `attachment.included` value in both cases, and that `referencedAt` gets stamped in both cases too.
- **Frontend unit tests**: `ChatInput`'s button and drag-drop paths both reach the same staged-attachment state; warning badge shows/hides correctly as `requiresVision`/`imageInput` combinations change; remove-chip triggers the delete call.
- **Frontend unit tests**: message-history rendering — image thumbnail, colored doc box per extension, and the "Attachments Not Processed" action's presence/absence based on `included`.
- **Manual/e2e**: drag-and-drop onto the real browser DOM (jsdom drag events are notoriously unreliable — worth a real Playwright drag-and-drop check per the `run` skill's guidance on testing UI changes in an actual browser, not just unit tests).
