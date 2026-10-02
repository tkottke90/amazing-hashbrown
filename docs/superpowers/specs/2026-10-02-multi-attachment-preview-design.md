# Multi-attachment optimistic previews + click-to-open modal

Issue: [tkottke90/amazing-hashbrown#256](https://github.com/tkottke90/amazing-hashbrown/issues/256)

## Problem

When a user sends a chat message with an attached file, the message bubble
appears immediately (optimistic render) but with no indication a file was
attached — the attachment preview only shows up after the thread reloads
from the server. `use-thread.ts`'s `sendMessage` deliberately omits the
`attachment` field from the optimistic bubble (inclusion is a server-side
vision-gate decision), and nothing in the live SSE stream ever patches it
back in afterward — only a fresh `GET /threads/:id` read ever surfaces it.

Separately, today's attachment preview isn't visually consistent across
file types (images get a large `max-h-48` thumbnail, everything else gets a
`size-24` extension box), and clicking a preview does nothing.

While scoping this, we also decided to lift today's single-attachment
constraint (`ChatInput` stages exactly one file per message) to a real
multi-attachment model, since the UI work (uniform tiles, per-attachment
state) is naturally plural and retrofitting a list later would mean
revisiting all of this anyway. This touches the attachment data model,
server-side vision-gate resolution, and the provider-facing message content
— not just the UI.

## Goals

- A sent message's chat bubble shows every staged attachment immediately,
  without waiting for the server round-trip.
- Every attachment preview occupies a uniform square footprint, regardless
  of file type.
- Clicking a preview opens a modal: images/video get a lightbox, everything
  else gets a download dialog.
- Up to 4 attachments per message, each with its own independent
  inclusion/exclusion outcome.
- The live SSE stream patches the authoritative per-attachment outcome
  (included / excluded + reason) into the already-rendered bubble once the
  turn completes — no reload required.

## Non-goals

- Real video upload support. `AttachmentTile`/`AttachmentPreviewModal` branch
  correctly on `mimeType.startsWith('video/')` so a future issue can wire up
  video storage/classification without touching this UI, but
  `ACCEPTED_ATTACHMENT_TYPES` and the server's `isAllowedMimeType` allow-list
  are unchanged — no new upload capability ships here.
- Letting `Send` fire while an upload is still in flight. Files still fully
  upload before `Send` is usable, same as today's flow — this spec only
  fixes the *silent* version of that (see "Fixing the staging race" below).
- Attachment-only sends (no text). Unchanged — `canSend` still requires
  non-empty text.

## Data model

### Server (`api/`)

`UserMessageAttachment` (today, singular, `api/src/agents/thread-message-writer.ts`)
is unchanged per-item; `recordUserMessage` takes `attachments?: UserMessageAttachment[]`
instead of a single `attachment`. `thread_messages.payload` is a schema-less
JSON blob, so no DB migration is needed — old rows keep their singular
`attachment` key forever. The read path normalizes:

```ts
const attachments = payload.attachments ?? (payload.attachment ? [payload.attachment] : []);
```

`resolveAttachmentForTurn` → `resolveAttachmentsForTurn(attachmentIds: string[], ...)`,
calling today's per-id logic (vision-gate check, image vs. text-extraction
branch, large-text stub-offload) once per id and returning
`{ records: UserMessageAttachment[], injections: AttachmentInjection[] }`.

`attachment-awareness.middleware.ts` takes `AttachmentInjection[]` instead of
one, and builds a single content array on the turn's last `HumanMessage`:
the original text plus every `text`/`excluded` injection's notation appended
in order, plus one `{ type: 'image', ... }` block per `multimodal`
injection. This generalizes today's "1 text block + 1 optional image block"
to "1 text block + N image blocks," which is the same shape every
vision-capable provider already expects for multi-image turns.

`streamChatToSse` and the workspace-chat / wiki-ingestion equivalents take
`attachmentIds?: string[]` instead of `attachmentId?: string`.

### Shared types (`lib/llm-common-types/src/chat/sse-events.ts`)

Define `UserMessageAttachmentSchema` once (id/filename/mimeType/included/
exclusionReason) and have both the API's `UserMessageAttachment` and the
UI's `ThreadMessage`'s attachment field derive from it via `z.infer`,
replacing the two hand-duplicated shapes that exist today.

Add `attachments: UserMessageAttachmentSchema.array().optional()` to both
`StreamDoneSchema` and `StreamErrorSchema` — the same terminal events that
already carry `assistantSeq`/`userSeq` specifically so the UI can patch the
live session without a reload (see those fields' existing comments). A turn
can fail after attachments have already resolved (resolution happens before
the LLM call), so both terminal events need it.

### UI (`ui/src/types/thread-message.ts`)

The `user` message kind's `attachment?: {...}` becomes
`attachments?: UserMessageAttachment[]` (derived from the shared schema
above).

## Client flow

### Staging (`ChatInput`)

- `ChatInputProps.attachment: StagedAttachment | null` / `onAttachmentChange`
  become `attachments: StagedAttachment[]` / `onAttachmentsChange`, capped
  at 4.
- `stageFile` appends instead of replacing the previous staged attachment.
- The hidden file `<input>` gains `multiple`; `handleFileInputChange` and
  `handleDrop` iterate every selected/dropped file instead of taking only
  `[0]`.
- **Cap overflow**: a pick/drop that would exceed 4 only uploads the first
  N remaining slots; the rest are rejected with
  `attachmentError: "Only 4 attachments allowed per message — 2 files were skipped."`
- **Fixing the staging race**: today, `canSend` doesn't check upload status
  at all, so pressing Enter/Send while a file is still uploading silently
  sends the message *without* it (the `attachment` signal hasn't updated
  yet). A new `uploadsInFlight` counter signal increments when `stageFile`
  starts and decrements when it settles; `canSend` additionally requires
  `uploadsInFlight === 0`. While uploads are pending, the header shows a
  disabled, spinner `ChatInputChip` per in-flight upload (no remove button)
  so the disabled Send button isn't a silent dead end.
- `attachmentError` becomes `string[]` (one entry per failed upload in a
  batch) instead of a single string.
- `handleRemoveAttachment(id)` removes one staged item by id instead of
  clearing a single signal, and revokes that item's `previewUrl` (see
  below) if one exists.
- The composer's staged-attachment chips stay the existing compact
  `ChatInputChip` row (filename + X) — they are **not** switched to the new
  square-tile component. Only the sent message bubble gets tiles.

### Blur-up local preview

`stageFile` creates `URL.createObjectURL(file)` for image attachments only,
stored as `previewUrl` on the staged item (local-only; never sent to the
server). This exists purely to avoid a network round-trip delay on the
*first* render of the optimistic bubble's thumbnail — by the time `Send` is
pressed the upload itself has already finished (per "Fixing the staging
race" above), but fetching `/api/v1/artifacts/:id` over the network can
still take a moment. `AttachmentTile` renders the local blob URL immediately
(blurred), then swaps to the remote `<img>` and drops the blur once that
image's `onLoad` fires. The blob URL is revoked by `AttachmentTile` itself
(on that `onLoad`, or on unmount) and by `handleRemoveAttachment` if the
attachment is removed before send.

### Sending (`pages/chat/index.tsx`, `workspace-chat-tab.tsx`, `wiki/ingestion-chat.tsx`)

All three call sites get the same mechanical change:
`stagedAttachment: Signal<StagedAttachment | null>` →
`stagedAttachments: Signal<StagedAttachment[]>`, and
`thread.sendMessage(content, attachmentId)` →
`thread.sendMessage(content, stagedAttachments.value)` — the full staged
objects are passed through now, not just ids, since the optimistic bubble
needs the filename/mimeType/previewUrl metadata immediately.

### `use-thread.ts`

`sendMessage(content: string, attachments?: StagedAttachment[])`:

- Builds the optimistic user bubble with
  `attachments: attachments?.map(a => ({ id: a.id, filename: a.displayFilename, mimeType: a.mimeType }))`
  — `included` is deliberately left unset until the turn resolves.
- Posts `attachmentIds: attachments?.map(a => a.id)` in the turn body.
- `applyTurnSeq` is renamed to `applyTurnResult` and additionally patches
  `attachments` (the authoritative `included`/`exclusionReason` per item)
  onto the current user message from the `stream_done`/`stream_error`
  event's new `attachments` field — the same spot `seq` already gets
  patched, and the actual fix for "nothing in the live SSE stream ever
  patches it back in."

## Shared UI components

Following this repo's composition-over-customization principle
(`AGENTS.md`), this is two small presentational pieces, not one
config-driven mega-component:

### `AttachmentTile` (`ui/src/components/attachment-tile.tsx`)

```ts
interface AttachmentTileProps {
  id: string;
  filename: string;
  mimeType: string;
  previewUrl?: string; // local blob URL, images only, pre-swap
  excluded?: boolean;
  exclusionReason?: 'vision_unsupported' | 'artifact_missing';
}
```

Fixed square footprint (`size-20`, in line with today's `size-24` doc-box
scale). Renders:

- **Image**: `<img src="/api/v1/artifacts/:id">`, `object-cover`. While
  `previewUrl` is set and the remote image hasn't loaded yet, the blob URL
  renders underneath with a `blur-sm` filter that fades out on `onLoad`. On
  `onError` (e.g. a GC'd artifact on an old thread), falls back to the
  generic extension-box treatment below instead of a broken-image icon.
- **Video**: same shape as image (muted, no controls, first-frame poster) —
  not reachable today since no upload path produces a video mimeType, but
  the branch exists so a future video-upload issue doesn't need to touch
  this component.
- **Everything else**: today's `EXTENSION_BOX_CLASSES` colored box with the
  uppercased extension, just sized to match.
- **`excluded`**: a small corner badge (today's amber `AlertTriangle`),
  same tooltip copy as today's message-level warning, now anchored to the
  specific tile it applies to.

### `AttachmentPreviewModal` (`ui/src/components/attachment-preview-modal.tsx`)

Wraps `<Modal trigger={<AttachmentTile .../>}>` (this repo's
`@tkottke90/preact-dialog` convention — the tile itself is the trigger, per
`components/AGENTS.md`'s "trigger goes in the `trigger` prop" rule). Content
branches by mimeType:

- **Image/video**: full-size `<img>` / `<video controls>` lightbox.
- **Everything else**: filename, the extension badge, and an
  `<a href="/api/v1/artifacts/:id" download>` button. No extracted-text
  preview in this pass — just enough to retrieve the file, matching the
  issue's "dialog that lets the user download the asset."

`AttachmentTile` alone (no modal) stays usable standalone wherever a plain
preview is wanted later; `AttachmentPreviewModal` is the only consumer that
needs click-to-open behavior today.

## Message bubble layout (`ChatMessage`, `chat-message.tsx`)

`attachment?: ChatMessageAttachment` → `attachments?: ChatMessageAttachment[]`.
The single `AttachmentPreview` call is replaced by a
`flex flex-wrap gap-2 mb-2` row of `AttachmentPreviewModal`, one per
attachment. `ChatMessageAttachmentWarningAction` is deleted — its one call
site (`thread-message.tsx:52`, shared across all three chat surfaces via
`ThreadMessageItem`) is removed, along with the now-unused `actions` wiring
for it in `pages/chat/index.tsx`, superseded by the per-tile badge.

## Edge cases

- **Artifact 404** (deleted/GC'd attachment on an old thread): tile falls
  back to the extension-box treatment on `<img>` `onError`; the modal's
  download link 404s the same way other artifact-id links already do today.
- **Old history rows** (pre-change singular `attachment`): normalized to a
  one-item `attachments` array at the read boundary
  (`thread-store.ts` and `use-thread.ts`'s `reviveMessage`) — nothing
  downstream needs to special-case the old shape.
- **Mixed-outcome message** (one image excluded for vision, one PDF
  included via text extraction): each tile shows its own state
  independently; there is no message-level aggregate anymore.
- **Attachment-only artifact cleanup**: unchanged — `markArtifactReferenced`
  is called once per attachment in the resolved set, same as today's single
  call.

## Testing

- **Unit**: `AttachmentTile` (image vs. doc-box rendering, blur→sharp swap,
  excluded badge + tooltip), `AttachmentPreviewModal` (branches to lightbox
  vs. download dialog by mimeType), `resolveAttachmentsForTurn` (per-id
  vision-gate/extraction now plural, ordering preserved), `ChatInput`'s
  cap/truncation and `uploadsInFlight`-gated `canSend` logic.
- **Orchestration**: `attachment-awareness.middleware.ts` building one
  content array from N injections (text concatenation + N image blocks);
  `streamChatToSse` threading `attachmentIds[]` through to the SSE
  `stream_done.attachments` field; `use-thread.ts`'s `applyTurnResult`
  patching `attachments` onto the right optimistic message.
- **E2E** (`@user-workflow`):
  1. Attach an image and a PDF, send, and confirm both tiles render in the
     bubble immediately (before the turn completes) — mock the SSE stream
     per `e2e/AGENTS.md`'s pattern for this.
  2. Click the image tile → lightbox modal; click the PDF tile → download
     dialog.
  3. Mock a vision-unsupported model and confirm the image tile (only)
     shows the excluded badge once `stream_done` arrives, while the PDF
     tile shows no badge.
  4. Attempt to stage a 5th file and confirm the cap error and truncation.
