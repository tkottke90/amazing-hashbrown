## How to Disable a Skill Without Deleting It

If you want to temporarily suppress a skill — hiding it from the slash-command menu and search results — you can disable it in place rather than deleting its folder. The skill's files remain intact on disk and can be re-enabled at any time.

### How to Disable

Open the skill's `SKILL.md` file and add `enabled: false` to the YAML frontmatter:

```markdown
---
name: My Skill
description: Does something specific
enabled: false
---

[Skill instructions remain here, unchanged]
```

That's all. No restart is needed — the change takes effect on the next agent turn.

### What Disabling Does

- The skill is **hidden from the slash-command autocomplete menu**. Typing `/my-skill` will not match it.
- The skill **does not appear in `search_skills` results**.
- The skill **cannot be invoked** via slash command or natural language while disabled.
- The skill folder and all its files (scripts, references, etc.) **remain on disk**, unchanged.

### How to Re-enable

Set `enabled` back to `true`, or simply remove the `enabled` line entirely — the default is `true`:

```markdown
---
name: My Skill
description: Does something specific
---
```

The skill reappears in the menu immediately on the next turn.

### When to Use This

Disabling is useful for:

- **Seasonal or project-specific skills** you don't want cluttering the menu during unrelated work
- **Skills under development** that aren't ready for regular use yet
- **Temporarily hiding** a skill while you revise its instructions, without losing the current version

See [[How Skills Work]] for an overview and [[Skill Folder Structure]] for a reference on all frontmatter fields.
