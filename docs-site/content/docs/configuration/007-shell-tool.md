---
title: Shell Tool
section: Configuration
order: 8
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Shell Tool

Optional. Configures the `shell_exec` agent tool, and the same trusted executor used to run skill scripts.

| Key                | Type            | Default  | Description                                                                                                                     |
| ------------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `workingDirectory`  | string          | `"/app"` | Working directory for every spawned command.                                                                                    |
| `allowlist`         | array of string | `[]`     | Glob-style patterns for commands that run without user approval. `*` matches any characters, including spaces.                  |
| `denylist`          | array of string | `[]`     | Glob-style patterns that are always blocked, even if they also match the allowlist — denylist is checked first and always wins. |
| `env`               | object          | `{}`     | Environment variables injected into every spawned shell. The parent process's environment is **not** inherited.                 |

{% call code(language="yaml") %}
tools:
  shell:
    workingDirectory: /app
    allowlist:
      - "ls *"
      - "git status"
      - "git log *"
    denylist:
      - "rm *"
      - "sudo *"
    env:
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
{% endcall %}

Allowlist patterns are anchored — `"git *"` matches any `git` subcommand, but `"git"` on its own does **not** match `"git status"`. Because the shell's environment isn't inherited, `PATH` needs to be set explicitly if commands rely on it; add any other variables the agent's shell needs, such as a `GH_TOKEN` for git operations against private remotes.
