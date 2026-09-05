# Workspace File Media Preview — Design

**Date:** 2026-09-05
**Status:** Draft
**Related:** [Issue #135](https://github.com/tkottke90/amazing-hashbrown/issues/135)

---

## Goal

Let users preview images, audio, and video files opened from the workspace Files tab — natively, in place of the CodeMirror editor — instead of the current "Can't display this file" fallback. Also give the file tree a way to flag, before a file is even opened, that a file can't be previewed (unsupported type) or is too large to edit, so the fallback isn't a surprise.

---

## Problem

`GET /api/v1/workspaces/:id/files/*` (`workspace-files.route.ts:25`) is the only file-content route today, and it always responds `text/plain`. `getFileContentHandler` (`workspace-files.handlers.ts:64-96`) runs every file through `readFileGuarded` (`workspace-files.ts:206-234`), which 422s anything that isn't valid UTF-8 text or is over the 2MB cap. There is no route that serves raw bytes with a real `Content-Type`, which is what an `<img>`/`<audio>`/`<video>` element needs for its `src`. The frontend (`use-workspace-files.ts:76-87`) already has an `unsupported` tab state for this 422 case — it just has nowhere else to go.

---

## Non-goals

- Other binary formats (PDF, etc.) — image/audio/video only, per the issue.
- Any file-type detection beyond file extension — no content sniffing for classification (see [Classification](#classification) below for the tradeoff this accepts).
- A size cap on media files — the existing 2MB cap is a text-editor constraint (loading a whole file into CodeMirror) and doesn't apply to streaming bytes to a native media element.
- Uploading files via the Files page — filed as a separate follow-up issue.
- Cross-device sync of the mute preference (or any other client preference) — filed as a separate follow-up issue; this design uses `localStorage` only.
- Pausing background-tab media playback — the issue asks only for muting, not pausing.

---

## Design

### API endpoints

```
GET   /api/v1/workspaces/:id/files                existing tree endpoint — FileNode gains fields, below
GET   /api/v1/workspaces/:id/files/*/content       NEW — raw bytes, real Content-Type (replaces old /files/*)
PATCH /api/v1/workspaces/:id/files/*/content        MOVED from /files/* — same body/behavior as today
```

There is no standalone `GET /files/:file` metadata route. The tree already carries everything a client needs per file (see below), so a separate per-file metadata fetch would be a redundant round trip with no caller.

```ts
export interface FileNode {
  name: string;
  path: string; // relative to workspace root, forward-slash separated
  type: 'file' | 'dir';
  children?: FileNode[]; // only on type: 'dir'
  gitStatus?: 'M' | 'A'; // only on type: 'file', only when the workspace has git enabled

  // New, only on type: 'file':
  category: 'text' | 'image' | 'audio' | 'video' | 'unsupported';
  oversize: boolean; // true only for category: 'text' files over the 2MB cap
  content: string; // ready-to-use URL, e.g. /api/v1/workspaces/:id/files/lora_data/image_1.png/content
}
```

### Classification

`category` is decided purely by file extension, against a small hardcoded table in `workspace-files.ts` (no new dependency):

- Image: `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico`
- Audio: `mp3`, `wav`, `ogg`, `m4a`, `flac`
- Video: `mp4`, `webm`, `mov`, `ogv`
- Known-unsupported (binary formats that can't be text-edited or previewed): `pdf`, `zip`, `tar`, `gz`, `7z`, `rar`, `exe`, `dll`, `so`, `bin`, `dat`, `iso`, `class`, `jar`, `wasm`, `sqlite`, `db`, `woff`, `woff2`, `ttf`, `otf`, `eot`, `pyc`
- Anything else defaults to `'text'`

This is a deliberate accuracy/perf tradeoff, confirmed during design: a mislabeled file (e.g. a binary blob saved with a `.txt` extension) gets no tree warning, but still fails gracefully into today's existing fallback when actually opened, because `readFileGuarded`'s real content-sniff is still the enforcement point at request time — classification only decides what the tree *shows in advance* and how the content route *treats a request*, it never skips the real guard on read. The alternative (sniffing every file's bytes during the tree walk for 100% accuracy) would mean reading part of every file in the workspace on every tree load — rejected as a real perf cost that grows with workspace size.

`oversize` requires a `size` per file, so the tree walker now `stat`s every file (previously only used `readdir`'s dirent type, no per-file stat). It's `true` only when `category === 'text'` and `size` exceeds the existing 2MB cap — media files are never flagged oversize, since no cap applies to them.

### Content endpoint behavior

`GET /files/*/content`, branching on the same classification:

- `'text'` → unchanged from today: `readFileGuarded`, 2MB cap, 422 on too-large or a real binary-content surprise, else `text/plain` body.
- `'image'` / `'audio'` / `'video'` → no size cap; streams the file with `Content-Type` set from the extension table (e.g. `image/png`, `audio/mpeg`, `video/mp4`).
- `'unsupported'` → 422, same as today's binary case.

`PATCH /files/*/content` — identical to today's PATCH, only the route moved.

### File tree badges

`FileTreeRow` (`file-tree.tsx`), next to the existing `GitStatusBadge`:

- `category === 'unsupported'` → amber `AlertTriangle` icon, `title="Can't preview this file type"`
- `oversize === true` → a visually distinct icon (`FileWarning`, different color from the amber unsupported badge, e.g. slate/gray) so the two states don't read as the same problem — `title="File is too large to open"`

Both are icon + `title` only, no click behavior — same slot the git-status badge already occupies.

### Frontend: opening a file

`FileTreeRow`'s click handler passes the clicked `FileNode` itself to `openFile` (not just the path string), so `openFile` never has to search the tree by path:

```ts
export interface OpenTab {
  path: string;
  contentUrl: string; // node.content — used for GET (text/media) and PATCH (text)
  category: 'text' | 'image' | 'audio' | 'video' | 'unsupported';
  view: EditorView | null;
  savedContent: string;
  dirty: Signal<boolean>;
  error?: string;
  unsupported?: boolean; // true for category 'unsupported', OR a real 422 surprise on the text path
}

export async function openFile(workspaceId: string, node: FileNode): Promise<void> {
  // existing already-open-tab reuse check, by node.path, unchanged

  switch (node.category) {
    case 'unsupported':
      // push a tab with unsupported: true — no fetch attempt, the tree already told us
      break;
    case 'text':
      // fetch(node.content) as text; same 422-catch fallback as today for the rare
      // stale-classification case (tree cache said text, real read disagrees)
      break;
    case 'image':
    case 'audio':
    case 'video':
      // push a tab carrying contentUrl + category, no fetch — the media element's
      // src performs the GET natively
      break;
  }
}
```

`PATCH` (save) also switches to using `tab.contentUrl` directly instead of rebuilding the URL via `encodePath` — the server is the single source of truth for that URL, matching why `content` exists on the tree node in the first place.

### Frontend: `EditorPanel`

Branches on `tab.category` (a `switch`, exploiting the string union for exhaustiveness):

- `'unsupported'` → today's fallback message, unchanged
- `'image'` → `<img src={tab.contentUrl} class="max-h-full max-w-full object-contain" />`, centered in the pane
- `'audio'` / `'video'` → native `<audio>` / `<video controls>`, `src={tab.contentUrl}`, `muted={mediaMuted.value || activeTabPath.value !== tab.path}`. A small toolbar above it (replacing the Save/Discard row, which doesn't apply to media) holds a mute toggle button.
- `'text'` → today's CodeEditor + Save/Discard, unchanged apart from using `tab.contentUrl`.

### Mute preference

New `ui/src/hooks/use-media-mute.ts` — a plain module-level signal, matching the existing `openTabs`/`activeTabPath` style in this feature (not React Context, which this feature doesn't otherwise use):

```ts
const STORAGE_KEY = 'hashbrown-media-muted';
export const mediaMuted = signal<boolean>(localStorage.getItem(STORAGE_KEY) === 'true');
export function toggleMediaMuted(): void {
  mediaMuted.value = !mediaMuted.value;
  localStorage.setItem(STORAGE_KEY, String(mediaMuted.value));
}
```

Because all tabs stay mounted (existing behavior) and both `activeTabPath` and `mediaMuted` are read directly during render, switching tabs or toggling mute re-renders and updates each media element's `muted` prop live, with no extra plumbing.

Audio/video in a background tab keeps playing if the user started it before switching away — just muted, per the issue's actual requirement. Pausing background playback is out of scope.

---

## Error handling

| Case                                                                     | Behavior                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `stat()` fails for one file during the tree walk (e.g. deleted mid-walk) | That entry is skipped from the tree, same precedent as the existing symlink-skip — not a tree-wide error |
| File classified `'unsupported'` clicked in the tree                      | Tab opens directly into the fallback message — no fetch attempted                                  |
| File classified `'text'` but the real read finds binary content/too-large | Existing 422 → `tab.unsupported`/`tab.error` fallback, same as today                                |
| Media file's bytes can't be decoded by the browser (bad codec, etc.)     | Native browser media-element error state — no custom handling, out of scope                        |
| Save fails (disk error, permission denied)                               | Inline error near Save button; buffer and `dirty` state preserved — unchanged from today            |

---

## Testing

### Backend

- `workspace-files.ts`: extension → `category` classification table, including the default-to-`'text'` case and the known-unsupported list; `oversize` computed only for `'text'` files over the cap; media files never flagged oversize
- `workspace-files.handlers.test.ts`: `GET`/`PATCH` on the new `/content` path — 404/400/422 cases unchanged in behavior at the new URL; media `GET` returns the right `Content-Type` header and is not subject to the 2MB guard
- Tree endpoint test: a directory containing one file of each category (including an oversized text file) produces the expected `category`/`oversize`/`content` per node

### Frontend

- `use-workspace-files.test.ts`: all three `openFile` branches (`text`/media/`unsupported`) — media branches push a tab with no fetch call made; `text` keeps its existing fetch-and-fallback behavior; save uses `tab.contentUrl`
- `files-tab.test.tsx`: `EditorPanel` renders the correct element per `tab.category`; `muted` is `true` when the mute preference is on OR the tab isn't active, and `false` only when both are false
- `file-tree.tsx` badge test: `unsupported` and `oversize` render distinct icons with the expected `title`, and neither appears for a plain text file

### E2E

Extend the existing `e2e/tests/003-WorkspaceFileBrowser.spec.ts` suite (`@tkottke90/playwrite-test-runner` pattern already used there) rather than adding a new numbered suite — media preview is an extension of the same Files-tab flow that suite already covers, not a new feature area. New steps:

| Action                                                        | Expected outcome                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Click an image file in the tree                               | Tab opens showing an `<img>` with the file's content, not the CodeMirror editor  |
| Click an audio or video file in the tree                       | Tab opens showing a native player with playback controls                        |
| Click an unsupported-type file (e.g. a `.zip`)                 | Tree row shows the amber unsupported badge; tab opens directly into the fallback message |
| Click an oversized text file                                   | Tree row shows the distinct oversize badge (different icon from the unsupported one) |
| Toggle mute, then switch between two open media tabs           | Both tabs' media elements reflect the muted state; the inactive tab is always muted regardless of the toggle |

---

## Follow-up (out of scope, filed separately)

1. Preference persistence/versioning so settings like mute sync across devices, not just `localStorage` on one browser.
2. Files-page upload support, with a later enhancement to convert HEIC/HEIF uploads to a web-safe format (webp or png) before storing.
