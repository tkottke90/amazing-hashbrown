---
title: Workspace Trackers
section: Configuration
order: 10
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Workspace Trackers

Optional. Connects a workspace to an external issue tracker so the agent — and you, from the task drawer — can link tasks to real tickets instead of ones that only exist inside the app. GitHub is the only built-in adapter today.

| Key                                       | Type   | Default | Description                                                    |
| ------------------------------------------ | ------ | ------- | ---------------------------------------------------------------- |
| `workspaces.tasks.trackers.github.token`   | string | —       | A GitHub personal access token. See below for what it unlocks. |

{% call code(language="yaml") %}
workspaces:
  tasks:
    trackers:
      github:
        token: ${GITHUB_TOKEN}
{% endcall %}

Leaving this block out entirely (or the `token` field empty) doesn't turn the tracker off — it changes what it can do:

- **No token** — read-only mode. The tracker can resolve and link an existing GitHub issue or PR, using unauthenticated GitHub API calls, which are rate-limited to 60 requests/hour.
- **With a token** — a personal access token with `repo` scope (or `public_repo` for public repositories only) additionally lets the task drawer create new GitHub issues directly.
