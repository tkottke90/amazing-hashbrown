## How to Create a Skill

Creating a skill takes two steps: make a folder, and write a `SKILL.md` file inside it. No restart is needed — the skill is available immediately.

### Step 1: Create the Skill Folder

Inside the skills root directory, create a folder whose name will be the skill's identifier:

```bash
mkdir ./config/skills/my-skill
# or, in Docker:
mkdir ./data/skills/my-skill
```

The folder name becomes the default slash command trigger (e.g. `/my-skill`) unless you set a different one in the frontmatter.

### Step 2: Write SKILL.md

Create `SKILL.md` inside the folder:

```markdown
---
name: My Skill
description: Does something specific and useful
slashCommand: my-skill
---

When this skill is active, you should:

- Ask the user for the input you need if they haven't provided it
- [Describe the steps the agent should follow]
- [Specify the output format or tone]
- [Reference any tools the agent should use]
```

The frontmatter (between the `---` lines) contains the skill's metadata. The body is the instruction text the agent receives when the skill is invoked.

### Step 3: Invoke It

Type `/my-skill` in the chat input. The autocomplete menu will show it immediately. Select it, add any arguments, and send your message.

### Step 4: Add Scripts or Reference Files (Optional)

If your skill needs to run code or reference data files, add a `scripts/` or `references/` subfolder:

```bash
mkdir ./config/skills/my-skill/scripts
# Place your .js or .py files here
```

Then reference them in the skill body: "Run `scripts/process.py` with the file path as the first argument."

### Tips for Writing Good Skills

- **Be specific.** Vague instructions produce vague behavior. Name the tools the agent should use and the format it should produce.
- **Keep scope narrow.** A skill that does one thing well is more reliable than one that tries to do everything.
- **Use imperative language.** Write as if giving direct instructions: "Summarize the file in three bullet points" rather than "You might want to summarize…"
- **Test iteratively.** Invoke the skill, see how the agent responds, then refine the instructions.

See [[Skill Folder Structure]] for the full layout reference and [[Skill Scripts]] for adding executable scripts to a skill.
