# Human-in-the-Loop (ask_user)

The agent can pause its work and ask you a question using the `ask_user` tool. This creates an **interactive prompt card** inline in the chat thread. The agent's current turn is fully suspended — it won't proceed or time out until you respond.

## Prompt Types

### yes_no

Two buttons with configurable labels. Used for binary decisions before significant or potentially destructive actions.

Example labels: **"Approve" / "Deny"**, **"Continue" / "Cancel"**, **"Overwrite" / "Keep existing"**

### multiple_choice

A row of option buttons. Used when the agent needs you to choose from a defined set of alternatives — for instance, which wiki domain to write to, or which of several matching pages to update.

### free_text

A text input field. Used when the agent needs open-ended information it can't determine on its own — a URL, a name, a preference, or any freeform answer.

## Persistence

Pending prompts are stored in the database. If you close the browser, restart the server, or navigate away while a prompt is waiting, the prompt will still be there when you return. The agent remains suspended at exactly that point in its reasoning.

## Shell Approval Prompts

[[Shell Approval Flow]] prompts are a specialized form of `ask_user` built into the shell tool. They follow the same persistence rules and appear in the same style, but include the command being requested and offer the extra **"Approve & remember"** option.

## When You'll See ask_user

The agent is designed to proceed autonomously when possible and only interrupt when it genuinely needs your input. Common triggers:

- A file or page would be overwritten and the agent isn't sure you want that
- Multiple valid options exist and the choice is a matter of preference
- The agent needs a credential, API key, or external reference it doesn't have
- The next step has significant side effects (sending an email, modifying production data, etc.)
