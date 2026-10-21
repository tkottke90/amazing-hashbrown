---
status: accepted
---

# Unarchiving a task bumps updatedAt, unlike thread archiving

Thread Archiving deliberately leaves `updated_at` untouched on Archive/Unarchive, because a thread naturally gets a fresh `updatedAt` the instant it's continued — Unarchive doesn't need to do that work itself. A task has no equivalent "continue" action: Unarchiving a terminal task is the only thing that brings it back into view. So unlike the thread precedent, `unarchiveTask` bumps `updatedAt`, giving the task a fresh Done Lane Retention Window clock and making it reappear in the default board/Inbox view immediately — otherwise Unarchive on an old task could silently do nothing visible, staying hidden until the Show Archived toggle is opened again.
