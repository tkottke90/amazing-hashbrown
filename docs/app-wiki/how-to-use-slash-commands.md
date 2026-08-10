## How to Use Slash Commands

Slash commands are the fastest way to invoke a skill. They work like autocomplete-driven shortcuts: start typing `/` and a menu appears showing all available skills.

### Opening the Menu

Click in the chat input box and type `/`. The autocomplete menu opens immediately, showing all enabled skills with their names and descriptions. Continue typing to filter the list — the search matches against both the skill name and its description.

### Selecting a Skill

Once you see the skill you want:

- Press **Enter** or **Tab** to select the highlighted skill, or
- Click the skill name in the menu.

The skill name is inserted into your message. You can then add a space and type any additional context or arguments before sending:

```
/summarize https://example.com/long-article
```

```
/code-review please focus on error handling
```

### What Happens When You Send

The selected skill's instruction text is injected into the agent's context for that turn, alongside your message. The agent sees both the skill instructions and your message at the same time and follows them together. No special agent setup is required on your part.

### Arguments

Most skills accept free-form text after the skill name. The skill's instructions define what to do with arguments — for example, a summarization skill might treat everything after the skill name as a URL or file path to process.

### When a Skill Doesn't Appear

If a skill is missing from the autocomplete menu, check:

- The skill folder exists in the skills root directory
- `SKILL.md` is present inside it and has valid frontmatter
- The `enabled` field in the frontmatter is not set to `false`

### Natural Language Alternative

If you prefer not to use the slash menu, you can ask the agent to use a skill by name: "Use the pdf-processing skill to extract the text from this file." The agent will find and apply the skill through the `search_skills` tool.

See [[How Skills Work]] for an overview of the skill system and [[How to Create a Skill]] to build your own.
