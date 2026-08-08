# How to Configure the Shell Allowlist

The shell allowlist lets you pre-approve categories of commands so the agent doesn't prompt you for every routine operation. Approved commands run immediately with no interruption to the conversation.

## Where to Edit

Add patterns to `tools.shell.allowlist` in `config.yaml`, or go to **Settings → Tools → Shell** in the UI.

```yaml
tools:
  shell:
    allowlist:
      - "git status"
      - "git log *"
      - "git diff *"
      - "npm run *"
      - "ls *"
      - "cat *"
```

## Pattern Syntax

Patterns use standard **glob syntax** and are matched against the full command string:

- `*` matches any sequence of characters within a single segment (no path separators)
- `**` matches any number of segments including path separators
- A literal string (no wildcards) matches only that exact command

Examples:

| Pattern | Matches | Does not match |
|---|---|---|
| `git status` | `git status` | `git status --short` |
| `git *` | `git status`, `git log --oneline` | `git push --force` |
| `npm run *` | `npm run build`, `npm run test` | `npm install` |
| `cat *` | `cat README.md`, `cat src/index.ts` | — |

## Practical Tips

- **Start broad for read-only operations.** `git log *`, `git diff *`, `ls *`, and `cat *` are generally safe to allow without a prompt.
- **Be conservative with writes.** Commands like `git push`, `git commit`, and `rm` should usually require your approval so you stay aware of changes being made.
- **Use "Approve & remember" to discover patterns.** If you find yourself clicking Approve on the same command repeatedly, that's a good candidate to add permanently here.
- **Denylist takes priority.** Even if a command matches the allowlist, it will be rejected if it also matches a denylist pattern. See [[Shell Execution Tool]].

For environment variable setup, see [[How to Give the Shell Tool Access to Environment Variables]].
