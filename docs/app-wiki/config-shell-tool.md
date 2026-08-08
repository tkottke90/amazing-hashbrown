# Shell Tool Configuration

Shell tool behavior is configured under `tools.shell` in `config.yaml`. All keys are optional — omitting a key uses the default value shown below.

## Configuration Keys

### `workingDirectory`

The working directory for all shell commands.

```yaml
tools:
  shell:
    workingDirectory: /app
```

Default: `/app` in the Docker image. Set this to your project root or home directory so commands like `git status` and `ls` resolve against the right location.

### `allowlist`

An array of glob patterns that are auto-approved without prompting you. Commands matching any allowlist pattern run immediately.

```yaml
tools:
  shell:
    allowlist:
      - "git status"
      - "git log *"
      - "npm run *"
      - "ls *"
```

See [[How to Configure the Shell Allowlist]] for patterns and tips.

### `denylist`

An array of glob patterns that are always rejected. The agent is told the command was denied. Denylist patterns take priority — a command matching both lists is still rejected.

```yaml
tools:
  shell:
    denylist:
      - "rm -rf *"
      - "sudo *"
      - "shutdown *"
```

### `env`

A map of environment variable names to values injected into every shell session. Use `${VAR_NAME}` to read a value from the host process's environment at startup, keeping secrets out of the config file.

```yaml
tools:
  shell:
    env:
      GH_TOKEN: "${GITHUB_PAT}"
      AWS_PROFILE: "default"
      PATH: "/usr/local/bin:/usr/bin:/bin"
```

Always include a `PATH` entry — without it, commands like `git` and `python3` may not be found. See [[How to Give the Shell Tool Access to Environment Variables]] for more detail.

## Command Evaluation Order

1. Check denylist — deny wins immediately if matched
2. Check allowlist — auto-approve if matched
3. Neither matched — show [[Shell Approval Flow]] prompt
