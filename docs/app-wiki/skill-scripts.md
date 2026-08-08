## Skill Scripts

Skills can include executable scripts that the agent runs using the shell tool. Scripts live in the skill's `scripts/` subfolder. When a skill is active, the agent can invoke these scripts to perform tasks that go beyond what the language model can do directly — parsing binary files, calling external APIs, transforming data, and so on.

### Supported Languages

**JavaScript** scripts run in Node.js. They can use Node's built-in standard library modules. Third-party npm packages can be used if they are installed in the skill's directory (i.e. a `node_modules` folder exists there), but this is not set up automatically.

**Python** scripts are resolved using the following priority order:

1. A per-skill `.venv/` virtual environment, if one exists inside the skill folder. This is the recommended approach for skills with Python dependencies.
2. `uv run`, if `uv` is available on the system. The Docker image includes `uv` by default, making this a convenient fallback.
3. `python3` from the system PATH.

### How Scripts Are Called

The agent calls scripts via the shell tool — the same tool used for any shell command — so the usual approval flow and shell allowlist/denylist apply. To make a script callable, the SKILL.md instruction body should describe when and how to run it:

```
When the user provides a PDF file path, run:
  scripts/extract.py <path>
and include the output in your response.
```

Arguments are passed as positional command-line parameters. Scripts should write their output to stdout; the agent captures stdout as the result.

### Example Structure

```
skills/
└── pdf-processing/
    ├── SKILL.md
    ├── .venv/               # optional Python venv
    └── scripts/
        ├── extract.py       # Python script
        └── reformat.js      # JS script
```

### Python Dependency Management

To add Python dependencies for a skill:

```bash
cd ./config/skills/my-skill
python3 -m venv .venv
.venv/bin/pip install some-package
```

Or, using `uv`:

```bash
cd ./config/skills/my-skill
uv venv .venv
uv pip install some-package
```

The skill will use the `.venv` automatically when the agent runs its scripts.

See [[How Skills Work]] for an overview and [[Skill Folder Structure]] for the full layout reference.
