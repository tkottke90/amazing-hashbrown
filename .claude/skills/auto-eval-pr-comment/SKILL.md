---
name: auto-eval-pr-comment
description: >
  Publishes the findings of a finished auto-eval-loop session as a comment
  on the branch's open GitHub PR, using the gh CLI: check whether a PR is
  open for the current branch, dedupe against any existing eval-results
  comment for the same suite, compose a findings write-up from the
  eval-logs/auto-eval-<timestamp>.yaml audit trail in this repo's
  established comment format, and post it with `gh pr comment` (or update
  the prior comment in place). Use this after the auto-eval-loop skill
  finishes, or whenever someone says "post the eval results to the PR,"
  "comment the eval findings on the pull request," "share the auto-eval
  results on the PR," "update the PR with what the eval loop found," or
  asks to publish/report eval-loop results anywhere on GitHub. The
  eval-logs/ directory is gitignored, so this comment is the only durable,
  reviewable record of the loop — post it whenever a loop that touched a
  PR branch completes.
---

# Auto-eval PR comment

Sibling to the `auto-eval-loop` skill, run **after** a loop completes. The
loop's audit trail lives in `eval-logs/auto-eval-<timestamp>.yaml`, and
`eval-logs/` is **gitignored** (`.gitignore:157`) — so nothing the loop
learned ever reaches the PR unless it's written up as a comment. This skill
turns the audit trail into that comment. The driver is the `gh` CLI; all
paths below are relative to the repo root.

## Prerequisites

- `gh` authenticated: `gh auth status` succeeds for github.com.
- A completed auto-eval log to report on (see step 1).

## Step 1 — Gather the source material

Identify the auto-eval log for this session — the same
`eval-logs/auto-eval-*.yaml` the loop was appending to (if the conversation
already has one in play, use it; otherwise take the newest and confirm with
the user it's the run they mean). Read it in full: `runs:` gives the score
trajectory per model per round, `log:` gives the diagnosis narrative,
`modifications`, and per-round `commit` SHAs.

You will also usually need:

- `config/config.yaml` `providers:` — maps eval model names (`ornith`,
  `glm`, `local`) to what's actually served (`defaultModel`) and how
  (`type`), for the "Models used" table.
- The per-round result YAMLs referenced by `runs[].models[].details`, when
  the log summary alone isn't specific enough about a failure worth
  narrating.

**Check the referenced commits are pushed** before posting — the comment
cites SHAs, and `eval-logs/` being gitignored means those SHAs are the only
thing a reader can follow:

```bash
git log origin/$(git branch --show-current) --oneline | head -5
```

If the round commits aren't on the remote yet, push first (never force).

## Step 2 — Check for an open PR on this branch

```bash
gh pr view --json number,title,url,state
```

- Success → JSON like
  `{"number":44,"state":"OPEN","title":"...","url":"https://github.com/..."}`.
  Use `number` for the remaining steps. If `state` is not `OPEN` (merged or
  closed PRs still resolve), stop and tell the user — don't comment on a
  closed PR without being asked.
- Exit code 1 with `no pull requests found for branch "<name>"` → report
  that to the user and stop. Do **not** create a PR on your own; offer it
  as a follow-up.

## Step 3 — Dedupe against existing eval comments

List existing comments via REST (the GraphQL `gh pr view --json comments`
does not return the numeric IDs needed for editing — use `gh api`):

```bash
gh api repos/{owner}/{repo}/issues/<number>/comments \
  --jq '.[] | {id: .id, user: .user.login, head: .body[0:60]}'
```

(`gh api` expands the literal `{owner}/{repo}` placeholders itself — paste
them as-is.) Ignore bot entries (e.g. `github-actions[bot]` posts a
Playwright report here). If a human comment's heading already names the
same suite (they all start `## ...` with the suite id in backticks):

- If this session's run **supersedes** it (same loop continued, better
  numbers), update that comment in place — see "Updating" below.
- If it's a genuinely separate earlier run, ask the user whether to update
  or post a new comment. Never silently post a second comment for the same
  suite.

One comment per suite: when a session covered multiple suites, write one
comment each and cross-reference ("See the `wiki-navigation` results
comment above"), as the real examples do.

## Step 4 — Compose the comment body

Write the body to a file — never inline with `--body`, the format is full
of backticks and multi-line Markdown that shell quoting will mangle.
Follow `references/comment-format.md` (structure distilled from the two
real comments on PR #37 and PR #44, with fetch commands to read them).
Everything in the comment must come from the actual log/results in front
of you — real scenario IDs, real numbers, real SHAs.

## Step 5 — Post it

```bash
gh pr comment <number> --body-file /tmp/eval-comment.md
```

Prints the comment URL, e.g.
`https://github.com/tkottke90/amazing-hashbrown/pull/44#issuecomment-5169159635`
— the number after `#issuecomment-` is the REST comment ID for any later
edit. Relay the URL to the user.

## Updating an existing comment

`-F body=@<file>` reads the body from the file (the `@` prefix matters —
`-f` would send the literal string):

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<comment-id> \
  -F body=@/tmp/eval-comment.md --jq '.html_url'
```

Deleting (e.g. a mispost) is
`gh api -X DELETE repos/{owner}/{repo}/issues/comments/<comment-id>`.
Both verified working; only ever edit/delete comments this workflow
created — not the user's hand-written ones, without asking.

## Gotchas

- **`gh pr view --json comments` has no usable comment IDs.** It's
  GraphQL; the `id` you need for PATCH/DELETE is the REST numeric ID.
  List via `gh api repos/{owner}/{repo}/issues/<number>/comments`, or take
  the ID from the `#issuecomment-<id>` fragment of the URL that
  `gh pr comment` prints.
- **Bot comments are in the list.** This repo's CI posts a
  `github-actions[bot]` Playwright report on every PR — filter by author
  before matching headings.
- **Dangling SHAs.** The comment's commit references are its audit trail
  (the YAML log itself never gets pushed). Posting before the round
  commits are on the remote produces SHAs nobody can open.
- **A previous session may already have posted.** The loop and the
  comment don't always happen in the same conversation — step 3's dedupe
  check is load-bearing, not ceremony. (Exactly this happened when this
  skill was built: PR #44 already carried the `web-fetch` comment.)
