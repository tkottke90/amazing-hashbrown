## How Skills Work

Skills are reusable instruction sets that customize the agent's behavior for a specific task. Rather than repeating complex instructions in every message, you define them once in a skill file and invoke the skill whenever you need it. The agent receives the skill's instructions in its context alongside your message and follows them for that turn.

### What a Skill Is

A skill is a folder inside the skills directory (default: `./config/skills`, or `./data/skills` in Docker). Each skill folder contains at minimum a `SKILL.md` file with:

- **YAML frontmatter** — metadata including the skill's name, description, and optional slash command trigger
- **Markdown body** — the instruction text injected into the agent's context when the skill is active

### Where Skills Live

Skills are stored on disk in the skills root directory. You can add, edit, or remove skills at any time — no restart is needed for the changes to take effect.

The agent can list and search available skills via the built-in `search_skills` tool. You can also browse them through the slash-command autocomplete menu.

### How to Invoke a Skill

There are two ways to activate a skill:

1. **Slash commands** — type `/` in the chat input box to open the autocomplete menu. Continue typing to filter by name or description. Press Enter or click to select the skill. You can add arguments after the skill name: `/summarize https://example.com`.

2. **Natural language** — ask the agent directly: "Use the code-review skill to check this function." The agent will locate the skill via `search_skills` and apply its instructions.

### What Skills Can Include

Beyond the SKILL.md instruction body, a skill folder can contain:

- **`scripts/`** — executable JavaScript or Python scripts that the agent can run via the shell tool (see [[Skill Scripts]])
- **`references/`** — data files, schemas, or templates the agent or scripts can read

The instruction body can reference these files by relative path and tell the agent how to use them.

### Common Use Cases

- Document processing (PDF extraction, summarization)
- Code review checklists
- Structured output formats
- Domain-specific workflows (filing issues, writing release notes)
- Project-specific conventions the agent should follow

See [[Skill Folder Structure]], [[Skill Scripts]], [[How to Create a Skill]], and [[How to Use Slash Commands]] for next steps.
