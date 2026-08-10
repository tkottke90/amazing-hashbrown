---
name: release
description: >
  Cuts and publishes a full release of this repo end-to-end: verifies the npm
  and Docker builds actually succeed before touching anything, bumps the
  version with `npm version`, writes an end-user-facing changelog, rebuilds
  and tags the Docker image, saves it as a release artifact, and publishes a
  GitHub Release with the image attached before pushing both a versioned and
  `latest` tag to the Docker registry. Use this whenever the user wants to
  cut, ship, or publish a release of this app, says things like "release
  v1.2.0", "let's do a patch release", "publish a new version", "ship this to
  the registry", or asks to bump the version and get it out the door — even
  if they only mention one part of it (e.g. "bump the version") since version
  bumps on this repo are meant to flow straight into a full release. This is
  the whole pipeline for this project, not just the changelog step — prefer
  it over anything that only drafts release notes for an already-existing
  tag.
compatibility: >
  Requires git, npm, a running Docker daemon logged into
  docker.artifacts.tdkottke.com, an authenticated GitHub CLI (`gh`), and a
  valid npm.artifacts.tdkottke.com token in `~/.npmrc` (checked by
  `npm run build:app`, this repo's `bin/docker-build.sh`). Project-specific:
  hardcodes this repo's Dockerfile, registry host, and build scripts.
---

# Release

This pipeline exists to avoid a specific pain: cutting a version, discovering
the build was broken all along, and having to burn a patch release just to
fix it. Everything that can fail cheaply (`npm run build`, `docker build`)
runs *before* anything that leaves a permanent mark (`npm version`, git tags,
pushes, a public GitHub Release). Respect that ordering — it's the whole
point of the guard step.

All mechanical steps live in `scripts/release.sh <phase> [args]`, one phase
per shell function. Use it rather than re-deriving these commands inline —
the phase boundaries are what make failures land on a clearly-named step
instead of somewhere in a wall of commands, and what make the changelog step
(which needs your judgment, not a script) separable from everything around
it. Run every phase from the repo root; the script `cd`s there itself.

## 0. Figure out the version and confirm the plan

Run `scripts/release.sh pkg-info` to get the package name and current
version. Then ask the user which bump they want — **major, minor, patch, or
a custom version string** — showing the current version for context, unless
they already stated it in their request (e.g. "release v1.2.0" needs no
extra prompt). Also ask whether this is a real run or a dry run if it isn't
obvious from context (see "Dry-run mode" below).

Run `scripts/release.sh preflight` next. It checks the working tree is
clean, `gh` is authenticated, the Docker daemon is up, you're logged into
the registry, and the current branch is `main` — releases must be cut from
main, not a feature branch. If it fails, stop and report exactly what's
wrong; don't try to work around a dirty tree, a wrong branch, or a
missing login yourself.

## 1. Build guard

```
scripts/release.sh build-guard
```

Runs `npm run build:app` — this repo's `bin/docker-build.sh`, which builds
the app, authenticates to the private npm registry using the token in your
local `~/.npmrc`, and builds the Docker image as `amazing-hashbrown:latest`.
That script owns the npm-auth mechanics; this phase doesn't duplicate them.
If it fails, **stop immediately** — do not bump the version. Report the
failure output as-is; these are real build errors that need fixing outside
this skill's scope, not something to patch over. This is the guard the
whole pipeline is built around, so don't skip it even if the user is in a
hurry.

## 2. Bump the version

```
scripts/release.sh bump-version <major|minor|patch|x.y.z> [--dry-run]
```

Real run: this calls `npm version`, which writes `package.json` /
`package-lock.json`, commits, and creates an annotated `vX.Y.Z` tag —
prints `NEW_TAG=vX.Y.Z` and `NEW_VERSION=X.Y.Z`. From here on, a local git
commit and tag exist even though nothing has been pushed yet.

Dry run: computes the hypothetical next version with no git or file
changes, and prints `NEW_TAG=(skipped in dry-run — no git tag created)` so
downstream phases know not to expect a real tag.

## 3. Write the changelog

```
scripts/release.sh changelog-range <NEW_TAG-or-HEAD>
```

Use the real tag on a real run, or `HEAD` on a dry run (no tag exists yet).
This only gathers material — it prints the previous tag (or says there
isn't one) and the commit list in between. Drafting the actual changelog is
your job, not the script's, because it requires judgment a shell command
can't apply:

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

## 4. Rebuild Docker with the release version baked in

```
scripts/release.sh docker-build-release
```

Re-runs `npm run build:app`. Because this runs *after* step 2 has committed
the version bump, `bin/docker-build.sh` reads `COMMIT_SHA` and
`APP_VERSION` straight from the now-updated git HEAD and `package.json` —
no arguments needed, and it can't accidentally bake in a stale version.
Docker's layer cache makes this fast after step 1.

## 5. Tag the release image

```
scripts/release.sh docker-tag-version amazing-hashbrown:latest docker.artifacts.tdkottke.com/<pkg-name>:v<version>
```

## 6. Save it as a release artifact

```
scripts/release.sh docker-save docker.artifacts.tdkottke.com/<pkg-name>:v<version> /tmp/<pkg-name>-<version>.tar
```

The script warns if the tar lands near GitHub's 2GB release-asset limit —
if you see that warning, flag it to the user before continuing; there's no
automatic fallback for an oversized artifact.

## 7. Stop and confirm before publishing anything

Everything above this line is local: builds, a local commit, local tags,
local Docker images, files in `/tmp`. Nothing has left your machine.
Everything below this line is public — a pushed tag, a GitHub Release, and
images pushed to the shared registry. **Show the user the full plan before
proceeding**: the version, the changelog you drafted, the artifact paths,
and the exact list of commands about to run (git push, `gh release
create`, docker tag `latest`, two docker pushes). Wait for explicit
go-ahead. This is the one gate in the whole pipeline — everything before it
runs without stopping, so make this pause count.

## 8. Publish

```
scripts/release.sh publish <tag> docker.artifacts.tdkottke.com/<pkg-name> <version> <tarfile> <changelog-file> [--dry-run]
```

Pushes the branch, pushes the tag, creates the GitHub Release (title = tag,
body = the changelog file, with the tar attached as the release asset),
tags the image `latest`, and pushes both the versioned and `latest` tags.
`--dry-run` prints each command instead of running it — use this to
validate the plan without it being real.

If any step in `publish` fails, **stop and report exactly which step
failed and which ones already succeeded** (the script prints each command
before running it via `set -e`, so the last printed line tells you where
it stopped). Don't try to roll back the version bump or undo already-public
actions on your own — report the state clearly and let the user decide
what to do next, since by this point some of it may already be visible to
other people.

## Dry-run mode

Use dry-run to validate the pipeline without creating a real release —
useful when testing changes to this skill, or when the user wants to see
the plan before committing to it. In dry-run:

- `preflight`, `pkg-info`, `build-guard`, `docker-build-release`,
  `docker-tag-version`, `docker-save`, and `changelog-range` all run for
  real — they're local and side-effect-free (or their side effects are
  just local build artifacts), so running them for real is what actually
  tests the pipeline.
- `bump-version --dry-run` computes the hypothetical version without
  touching git or `package.json`. Because of that, if you also run step 4
  (`docker-build-release`) in a dry run, it still calls `npm run build:app`
  for real and still bakes in a real `APP_VERSION` — just the *current*
  (unbumped) one, since `package.json` was never touched. Treat that
  version number as a known cosmetic inaccuracy of dry-run mode, not a bug.
- `publish --dry-run` only prints the commands it would run.

A full dry run therefore still catches real build breakage, real Docker
build/tag/save issues, and real changelog content — it only skips the
truly external-facing actions.
