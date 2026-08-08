# Shell Approval Flow

When the agent wants to run a shell command that isn't on the allowlist (and isn't denied), it pauses and shows an **approval prompt** in the chat interface. The agent's current turn is suspended — it won't time out or proceed until you respond.

## What You See

The prompt card appears inline in the message thread and shows:

- The **command** in a code block
- The agent's **stated reason** for wanting to run it
- Three response buttons

## Your Options

### Deny

The command is rejected. The agent is informed it was denied and can try a different approach — for example, using a different tool, asking you for information directly, or abandoning that line of reasoning.

### Approve

The command runs once. The next time the agent wants to run the same command (even in the same conversation), it will prompt again.

### Approve & Remember

The command runs, and the pattern is added to a **session allowlist** for the duration of this thread. It won't prompt again during this conversation. This is useful for discovering which commands you approve repeatedly so you can later add them permanently to the config.

**Note:** "Approve & remember" patterns are not persisted between sessions. When the thread ends or you start a new conversation, those remembered approvals are gone. To make an approval permanent, add the pattern to `tools.shell.allowlist` in `config.yaml` — see [[Shell Tool Configuration]] and [[How to Configure the Shell Allowlist]].

## Persistence

Pending approval prompts are stored in the database. If you close the browser or restart the server while a prompt is waiting, the prompt will still be there when you return. The agent remains suspended until you respond.
