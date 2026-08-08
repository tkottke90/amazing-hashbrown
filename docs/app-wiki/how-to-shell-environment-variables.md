# How to Give the Shell Tool Access to Environment Variables

Shell commands run in an **isolated environment** — they do not automatically inherit the variables from the host process or the Docker container's environment. To make a variable available inside shell commands, you must explicitly map it in `config.yaml`.

## Adding Variables

Add entries to `tools.shell.env` in `config.yaml`:

```yaml
tools:
  shell:
    env:
      GH_TOKEN: '${GITHUB_PAT}'
      AWS_PROFILE: 'default'
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin'
```

## The `${VAR_NAME}` Syntax

Values written as `${VAR_NAME}` are resolved from the **host process's environment at startup** — not at the time the command runs. This lets you keep secrets out of `config.yaml` itself:

1. Set the secret as a real environment variable on the host (or in Docker Compose's `environment:` section).
2. Reference it in `config.yaml` using `${VAR_NAME}`.

At startup, amazing-hashbrown reads the actual value and stores it for injection into shell sessions. The config file never contains the secret in plaintext.

## Always Set PATH

Without a `PATH` entry, commands like `git`, `npm`, `python3`, and `gh` may not be found by the shell. The Docker image's standard locations are:

```
/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
```

Copy that as a starting point and extend it if you have tools installed elsewhere.

## Common Variables to Set

- `GH_TOKEN` — GitHub personal access token for the `gh` CLI
- `AWS_PROFILE` / `AWS_REGION` — for AWS CLI commands
- `ANTHROPIC_API_KEY` — if shell commands need to call the API directly
- `PATH` — always required for basic command resolution

For denylist, allowlist, and working directory settings, see [[Shell Tool Configuration]].
