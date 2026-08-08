# Shell Execution Tool

The `shell_exec` tool gives the agent a bash terminal. It can run git commands, scripts, CLI tools, or any shell command — subject to a configurable policy that keeps you in control of what runs automatically versus what requires your sign-off.

## What's Available

The Docker image ships with these tools pre-installed for the agent's use:

- `git` — version control
- `curl` — HTTP requests from the command line
- `python3` — scripting and data processing
- `gh` — GitHub CLI for interacting with repos, PRs, and issues
- `uv` / `uvx` — fast Python package and environment management

## Policy Layers

Every command goes through three checks, in order:

### 1. Denylist

If the command matches a denylist pattern, it is **always rejected** — the agent is told it was denied and can try a different approach. The denylist takes priority over everything else.

### 2. Allowlist

If the command matches an allowlist pattern, it **runs immediately with no prompt**. Use this for routine, low-risk commands you're comfortable having the agent run freely (e.g. `git status`, `npm run *`).

### 3. Human Approval

If neither list matches, the agent **pauses and asks you** via an approval prompt in the chat UI. See [[Shell Approval Flow]] for your options at that point.

## Audit Log

Every command decision — approved, denied, or auto-allowed — is written to the `shell_audit_log` table in SQLite. Each record includes:

- Timestamp
- Full command string
- Outcome (allowed / denied / approved / rejected-by-user)
- Exit code (for commands that ran)
- Thread ID

This gives you a complete record of everything the agent has executed. For configuration details, see [[Shell Tool Configuration]].
