---
name: release
description: >
  Cuts and publishes a release of this repo end-to-end: verifies the app
  build actually succeeds before touching anything, bumps the version with
  `npm version`, writes an end-user-facing changelog, and publishes a GitHub
  Release — pushing the tag that triggers CI to build and publish the
  Docker image. Use this whenever the user wants to cut, ship, or publish a
  release of this app, says things like "release v1.2.0", "let's do a patch
  release", "publish a new version", "ship this to the registry", or asks to
  bump the version and get it out the door — even if they only mention one
  part of it (e.g. "bump the version") since version bumps on this repo are
  meant to flow straight into a full release. This is the whole pipeline for
  this project, not just the changelog step — prefer it over anything that
  only drafts release notes for an already-existing tag.
compatibility: >
  Requires git, npm, an authenticated GitHub CLI (`gh`), and a valid
  npm.artifacts.tdkottke.com token in `~/.npmrc` (checked by `npm run
  build`). Pushing the tag triggers `.github/workflows/release.yml`, which
  owns the Docker build and registry push — see "What happens after you
  push the tag" below. Project-specific: hardcodes this repo's tag
  convention and `bin/release.sh` phases.
---

# Release

This pipeline exists to avoid a specific pain: cutting a version,
discovering the build was broken all along, and having to burn a patch
release just to fix it. The build guard (`npm run build`) runs *before*
anything that leaves a permanent mark (`npm version`, git tags, pushes, a
public GitHub Release). Respect that ordering — it's the whole point of the
guard step.

All mechanical steps live in `bin/release.sh <phase> [args]`, one phase
per shell function. Use it rather than re-deriving these commands inline —
the phase boundaries are what make failures land on a clearly-named step
instead of somewhere in a wall of commands, and what make the changelog step
(which needs your judgment, not a script) separable from everything around
it. Run every phase from the repo root; the script `cd`s there itself. This
same script is also invoked by `.github/workflows/release.yml` — it's shared
between this skill and CI, not skill-private.

## 0. Figure out the version and confirm the plan

Run `bin/release.sh pkg-info` to get the package name and current
version. Then ask the user which bump they want — **major, minor, patch, or
a custom version string** — showing the current version for context, unless
they already stated it in their request (e.g. "release v1.2.0" needs no
extra prompt). Also ask whether this is a real run or a dry run if it isn't
obvious from context (see "Dry-run mode" below).

Run `bin/release.sh preflight` next. It checks the working tree is
clean, `gh` is authenticated, and the current branch is `main` — releases
must be cut from main, not a feature branch. If it fails, stop and report
exactly what's wrong; don't try to work around a dirty tree or a wrong
branch yourself.

## 1. Build guard

```
bin/release.sh build-guard
```

Runs `npm run build` — confirms the app actually compiles before anything
permanent happens. If it fails, **stop immediately** — do not bump the
version. Report the failure output as-is; these are real build errors that
need fixing outside this skill's scope, not something to patch over. This is
the guard the whole pipeline is built around, so don't skip it even if the
user is in a hurry.

## 2. Bump the version

```
bin/release.sh bump-version <major|minor|patch|x.y.z> [--dry-run]
```

Real run: this calls `npm version`, which writes `package.json` /
`package-lock.json`, commits, and creates an annotated `vX.Y.Z` tag —
prints `NEW_TAG=vX.Y.Z` and `NEW_VERSION=X.Y.Z`. From here on, a local git
commit and tag exist even though nothing has been pushed yet.

Dry run: computes the hypothetical next version with no `package.json` or
commit changes, but **does** create a real git tag —
`v<version>-dry-run-<unix-timestamp>` — at the current commit, and prints
that as `NEW_TAG`. This is not a no-op: that tag gets pushed in step 5 just
like a real one, so it exercises the real CI pipeline end-to-end. See
"Dry-run mode" below for what CI does differently for it.

## 3. Write the changelog

```
bin/release.sh changelog-range <NEW_TAG>
```

Gathers material for the range leading up to `NEW_TAG` — it prints the
previous tag (or says there isn't one) and the commit list in between.
`NEW_TAG` is always a real tag at this point, real run or dry run. Drafting
the actual changelog is your job, not the script's, because it requires
judgment a shell command can't apply:

- **This repo is an application** (UI + API + Dockerfile, `private: true`)
  — write for the people who *use* the app, not the people who maintain it.
  Describe what they'll see or feel ("Videos now load instantly") rather
  than the mechanism ("added CDN caching"). Skip pure release-machinery
  commits (version bumps, lockfile-only changes).
- If a commit subject references `#NN`, `gh pr view NN` or `gh issue view
  NN` usually explains the *why* far better than the subject line. For
  vague subjects ("fix build", "updates"), look at the actual diff rather
  than guessing — a wrong claim in release notes is worse than leaving it
  out.
- Lead with the most impactful change, not the chronologically first one.
  Breaking changes come first regardless, clearly marked with what the user
  needs to do about them. Group commits that together tell one story into
  one section instead of one bullet each.
- If there's no previous tag, this is the first release — cover the full
  history as one changelog instead of skipping it, and skip the compare
  link since there's nothing to compare against.
- This mirrors the approach in the standalone `github-release` skill in
  this environment; keep the tone consistent with it if you've seen its
  output before.

Write the result to `/tmp/<pkg-name>-<version>-changelog.md`.

## 4. Stop and confirm before publishing anything

Everything above this line is local: builds, a local commit, local tags,
files in `/tmp`. Nothing has left your machine. Everything below this line
is public — a pushed branch, a pushed tag (which triggers CI), and (for a
real run) a GitHub Release. **Show the user the full plan before
proceeding**: the version, the changelog you drafted, and whether this is a
real run or a dry run. Wait for explicit go-ahead. This is the one gate in
the whole pipeline — everything before it runs without stopping, so make
this pause count.

## 5. Publish

```
bin/release.sh publish <NEW_TAG> <changelog-file>
```

Pushes the branch, pushes the tag — this is what triggers CI — and, unless
`NEW_TAG` is a dry-run tag, creates the GitHub Release (title = tag, body =
the changelog file). For a dry-run tag it prints a `SKIP:` line instead of
creating a release.

If `publish` fails, **stop and report exactly which step failed and which
ones already succeeded** (the script prints each command before running it
via `set -e`, so the last printed line tells you where it stopped). Don't
try to roll back the version bump or undo already-public actions on your
own — report the state clearly and let the user decide what to do next,
since by this point some of it may already be visible to other people.

## What happens after you push the tag

Pushing the tag triggers `.github/workflows/release.yml`. It always
rebuilds the app and the amd64-only Docker image — that's the real build
validation, dry run or not. For a real (non-dry-run) tag it also:

- Logs into the Zot registry
- Tags and saves the image, uploads it as a `.tar` asset on the GitHub
  Release you created in step 5 (retrying briefly if the release hasn't
  finished propagating yet)
- Pushes both the versioned tag and `latest` to the registry

If CI's build fails on a tag that's already public, **don't try to roll it
back** — the tag and GitHub Release already exist. Recovery is fix-forward:
cut a new patch release, the same philosophy as any other failure after the
confirm gate.

## Dry-run mode

Use dry-run to validate the pipeline without creating a real release —
useful when testing changes to this skill, or when the user wants to see
the plan before committing to it. Unlike a true no-op, dry-run mode now
pushes a **real** tag — `v<version>-dry-run-<unix-timestamp>` — so it
exercises both the local steps and the real CI workflow end-to-end:

- `preflight`, `pkg-info`, `build-guard`, and `changelog-range` all run for
  real — they're local and side-effect-free (or their side effects are just
  local build artifacts), so running them for real is what actually tests
  the pipeline.
- `bump-version --dry-run` creates the real, suffixed tag described above —
  no `package.json` change, no commit.
- `publish` pushes the branch and the suffixed tag for real (triggering
  CI), but skips `gh release create`.
- CI's build step always runs for real against the dry-run tag — but it
  skips the Zot login, image tag/save/upload, and registry push steps,
  since `bin/release.sh detect-dry-run` recognizes the suffix.

Once you've confirmed the test run worked, clean up the tag — it isn't
deleted automatically:

```
git tag -d <dry-run-tag>
git push origin :refs/tags/<dry-run-tag>
```
