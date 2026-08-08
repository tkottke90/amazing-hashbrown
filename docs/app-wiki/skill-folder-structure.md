## Skill Folder Structure

Each skill is a folder inside the skills root directory (default: `./config/skills`, or `./data/skills` in Docker). The folder name serves as the skill's identifier and is used as the default slash command trigger if no explicit `slashCommand` is set in the frontmatter.

### Layout

```
skills/
└── my-skill/
    ├── SKILL.md          # required — instructions and metadata
    ├── scripts/          # optional — executable scripts
    │   ├── process.js
    │   └── analyze.py
    ├── references/       # optional — data files the agent or scripts can read
    │   └── schema.json
    └── .venv/            # optional — Python virtual environment for scripts
```

Only `SKILL.md` is required. All other files and folders are optional.

### SKILL.md Frontmatter Fields

The top of `SKILL.md` must contain a YAML frontmatter block delimited by `---`:

```markdown
---
name: My Skill
description: A one-line description shown in autocomplete and search results
slashCommand: my-skill
enabled: true
---
```

| Field          | Required | Default     | Description                                                         |
| -------------- | -------- | ----------- | ------------------------------------------------------------------- |
| `name`         | yes      | —           | Display name shown in the slash-command menu and search results     |
| `description`  | yes      | —           | One-line summary used in autocomplete filtering and `search_skills` |
| `slashCommand` | no       | folder name | The `/command` trigger for this skill                               |
| `enabled`      | no       | `true`      | Set to `false` to hide the skill without deleting it                |

### SKILL.md Body

Everything after the closing `---` of the frontmatter is the instruction text. Write it as if addressing the agent directly. Be specific about what the agent should do, which tools it should use, and how it should format output.

```markdown
---
name: My Skill
description: Does something specific
---

When this skill is active, you should:

- Read the file at the path the user provides
- Summarize its contents in bullet points
- Ask for clarification if the file type is not recognized
```

### scripts/ Subfolder

Scripts placed here can be invoked by the agent via the shell tool. Supported languages are JavaScript (Node.js) and Python. See [[Skill Scripts]] for details on the Python resolver order and dependency management.

### references/ Subfolder

Place static data files here — JSON schemas, prompt templates, lookup tables, or any other supporting material. Reference them by relative path in the skill instructions: "Read `references/schema.json` before validating the user's input."

See [[How Skills Work]] for an overview and [[How to Create a Skill]] for a step-by-step guide.
