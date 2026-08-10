# Thread Management

Threads are your conversation history. Every thread — along with all its messages, tool activity, and pending prompts — is stored in SQLite and survives server restarts and page reloads.

## The Sidebar

The left sidebar lists all your threads, ordered by most recent activity. Each entry shows the thread title and an AfterAgent status indicator:

- A spinner while background processing is in progress
- A brief confirmation when it completes

## Thread Actions

### Rename

Click the thread title directly to edit it inline. Press Enter to save, or Escape to cancel. Renaming doesn't affect messages or history.

### Auto-generate Title

Click the sparkle icon (✦) next to a thread to generate a short, descriptive title from the conversation content. Title generation uses an LLM call and takes a moment. This is handy for threads that started with a quick question and ended up covering a lot of ground.

### Delete

Deletes the thread and **all its messages permanently**. There is no undo. The database rows are removed, including any pending shell approval prompts or ask_user prompts.

### Fork

Creates a copy of the thread up to a specific message. To fork:

1. Hover over the message you want to fork from.
2. Click the fork icon that appears.
3. A new thread is created with all history up to (and including) that message.

The original thread is unchanged. Forking is useful when you want to explore an alternative response or take the conversation in a different direction without losing your main thread. The forked thread starts fresh from that point — the agent has no memory of what came after the fork point in the original.

## Storage Details

All thread data lives in the `threads` and `messages` tables in the SQLite database. The database file location is set by `db.path` in `config.yaml`. There is no automatic thread expiry — threads accumulate indefinitely unless you delete them manually.
