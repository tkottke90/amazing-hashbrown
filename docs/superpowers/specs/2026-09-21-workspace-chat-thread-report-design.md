# Workspace Chat Thread Report Button

Resolves [#174](https://github.com/tkottke90/amazing-hashbrown/issues/174).

## Problem

The Workspace Chat interface has no way to view a session's Thread Report,
unlike Thread and Wiki Chat, which both link to `/api/v1/threads/:id/report`
in a new tab.

## Design

Add an icon button to `ui/src/pages/workspaces/workspace-chat-tab.tsx`,
in the action-bar row that currently holds only the Summarise button
(around line 126-137).

- Import `Download` from `lucide-preact`.
- Wrap the row's right-hand side in `<div class="flex items-center gap-1">`
  containing the new button followed by the existing Summarise `Button`.
- The new button is a raw `<button>`, copied from the Wiki Chat
  implementation (`ui/src/pages/wiki/ingestion-chat.tsx:102-109`) verbatim:
  same classes, same `title="Generate thread report"` tooltip, same
  `Download` icon at `size-3.5`.
- `onClick` opens `` `/api/v1/threads/${workspace.threadId}/report` `` via
  `window.open(url, '_blank')`.

No backend changes: the generic `/api/v1/threads/:id/report` endpoint
already exists and is keyed by thread ID, which is what both Thread and
Wiki Chat use today. The issue text refers to a "Workspace `chatId`
property," but `Workspace` has no such field — the equivalent identifier
is `workspace.threadId`, already used for every other chat operation in
this component.

No null-guard is needed for `workspace.threadId`: the component already
returns `null` earlier in the function if it is unset, so the action-bar
row only ever renders once it's a real string.

## Testing

- Manual: open a workspace with an active chat thread, click the new
  button, confirm a new tab opens showing the Thread Report for that
  thread ID.
- No new unit/e2e tests planned — this mirrors an existing, already-tested
  pattern (Wiki Chat's identical button) and adds no new logic beyond a
  URL string.
