# Move Release Build/Publish into CI

## Problem

The `/release` skill today runs entirely on a developer's machine: it needs a
running Docker daemon, a login to `docker.artifacts.tdkottke.com`, and a
valid `npm.artifacts.tdkottke.com` token in `~/.npmrc`. Every release ties up
a local machine for the build+push, and depends on whoever's running it
having all of that set up correctly. We now have `ZOT_URL`/`ZOT_TOKEN` (Zot
Docker registry) and `NPM_DOMAIN`/`NPM_TOKEN` (private npm registry)
available as GitHub Actions vars/secrets, so the build-and-publish mechanics
can move to CI.

## Goal

Split the release process along the line that already exists in
`scripts/release.sh`'s phases: judgment calls and git/GitHub operations stay
local (via the `/release` skill, Claude-assisted); mechanical,
credential-heavy build/push work moves to a new CI workflow triggered by the
tag push that's already part of today's flow. Preserve the dry-run mode by
re-purposing it as a real, quarantined end-to-end test of both halves,
instead of the current local-only no-op.

## Architecture

```
Local (/release skill)                    CI (.github/workflows/release.yml)
───────────────────────                   ──────────────────────────────────
0. ask bump type + real/dry-run
1. preflight (clean tree, gh auth,
   branch == main)
2. build-guard: npm run build
3. bump-version                   ──tag──▶  triggered by `push: tags: v*`
   real: npm version → commit+tag           1. detect-dry-run (from tag name)
   dry-run: hypothetical version,            2. npm run build:app
            real tag suffixed                   (SKIP_ARM64_BUILD=true)
            `-dry-run-<timestamp>`,          3. if NOT dry-run:
            no commit                           - docker login (Zot)
4. changelog-range <tag>                        - docker-tag-version
   (always a real tag now, no HEAD                + docker-save
    special case)                               - release-upload-asset
5. STOP — show plan, confirm                      (tar → GitHub Release)
6. publish <tag> <changelog-file>                 - registry-publish
   - push branch, push tag (triggers CI)            (push vX.Y.Z + latest)
   - gh release create (skipped for
     dry-run tags)
```

Pushing the tag is the one moment that crosses from local to CI, and it's
also still the single human checkpoint — nothing downstream needs its own
approval gate because a tag only exists because someone already decided to
publish it (or, for a dry run, decided to test the pipeline).

## Why the dry-run tag re-send

Today, `bump-version --dry-run` computes a hypothetical version and creates
no git tag at all — the rest of the pipeline then runs for real against
local build/Docker artifacts, but nothing is pushed. Once the Docker build
and push move entirely into CI, a "dry run" that never pushes a tag can no
longer exercise the CI half at all.

Instead, dry-run mode now creates a **real** tag — `v<version>-dry-run-<unix
timestamp>` — at the current commit (no `package.json` change, no new
commit) and pushes it like any other tag. That real push triggers the real
CI workflow, which runs the real build and Docker build, giving an authentic
end-to-end test of both halves. CI detects the suffix and skips only the
truly external-facing steps (Zot login/push, release asset upload) — exactly
mirroring which steps today's local dry-run mode already treats as
side-effect-free vs. not.

The suffix regex (`-dry-run-[0-9]+$` or `-test-[0-9]+$`) is anchored at the
end and requires a trailing run of digits, so it can never match a real
prerelease tag like `v1.2.0-alpha`, `v1.2.0-beta.2`, or `v1.2.0-rc.1`. The
skill only ever emits `-dry-run-`; `-test-` is accepted purely so an ad-hoc
tag pushed by hand (outside the skill) can still exercise the pipeline
without touching the registry or creating a release.

Dry-run tags aren't deleted automatically (deleting a remote tag while CI
might still be reading it would race) — the skill prints a reminder command
to clean up the local and remote tag once the test run is confirmed working.

## Components

### 1. `scripts/release.sh`

- **`preflight`** — drop the Docker daemon and `docker login` checks
  entirely. Keeps: clean working tree, `gh` authenticated, branch is `main`.
  Local no longer needs Docker installed or any registry login at all.
- **`build-guard`** — runs `npm run build` instead of `npm run build:app`.
  This is now purely a "does it compile" guard; the Docker image build moves
  to CI.
- **`bump-version`** — the `--dry-run` branch changes behavior: instead of
  printing `NEW_TAG=(skipped in dry-run...)`, it creates a real lightweight
  tag `v<hypothetical-version>-dry-run-<unix-timestamp>` at `HEAD` (via
  `git tag`, no commit) and reports that as `NEW_TAG`. The real-run branch is
  unchanged.
- **New phase `detect-dry-run <tag>`** — the single source of truth for the
  dry-run regex. Prints `is_dry_run=true` or `is_dry_run=false` in
  `key=value` form so it works both redirected into `$GITHUB_OUTPUT` from CI
  and read directly when run locally. `publish` also calls this internally
  to decide whether to skip `gh release create`.
- **New phase `release-upload-asset <tag> <tarfile>`** — wraps
  `gh release upload <tag> <tarfile> --clobber`, retrying a handful of times
  (a few seconds apart) before failing with a clear "no release found for
  tag X" message. Covers the edge case where CI's build finishes before
  local's `gh release create` has propagated (unlikely in practice — local
  release creation takes seconds, CI's build takes minutes — but cheap to
  guard against instead of failing on a cold miss).
- **New phase `registry-publish <image-base> <tag>`** — extracted from
  today's `publish`: tags `<image-base>:latest` from `<image-base>:<tag>`,
  pushes both the version tag and `latest`.
- **`publish`** — drops every Docker/tar argument. New signature:
  `publish <tag> <changelog-file>`. Pushes the current branch, pushes the
  tag (this is what triggers CI), then — unless `detect-dry-run` says this
  tag is a dry run — runs `gh release create <tag> --title <tag> --notes-file
  <changelog-file>`.
- **`docker-build-release`, `docker-tag-version`, `docker-save`** — kept,
  unchanged signatures. They're simply invoked from CI now instead of from a
  developer's machine.
- Drop the now-unused `REGISTRY_HOST` constant (its only consumer was the
  deleted `preflight` Docker-login check). CI passes full image references —
  `${{ vars.ZOT_URL }}/amazing-hashbrown:<tag>` — directly as arguments to
  `docker-tag-version`/`docker-save`, the same calling convention the script
  already uses today.

### 2. `bin/docker-build.sh`

Wrap the second (`linux/arm64`) `docker build` call:

```bash
if [ "${SKIP_ARM64_BUILD:-false}" != "true" ]; then
  docker build -t amazing-hashbrown:arm64 --platform linux/arm64 ...
fi
```

The arm64 image exists purely for native local testing on Apple Silicon —
CI runners are amd64 and never consume that tag, so building it there is
pure wasted time. CI sets `SKIP_ARM64_BUILD=true`; local invocations are
unaffected (still build both by default).

### 3. New `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write # gh release upload

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Detect dry run
        id: detect
        run: scripts/release.sh detect-dry-run "${{ github.ref_name }}" >> "$GITHUB_OUTPUT"

      - name: Setup npmrc
        run: |
          touch ~/.npmrc
          echo "registry=https://${NPM_DOMAIN}/" >> ~/.npmrc
          echo "save-exact=true" >> ~/.npmrc
          echo "//${NPM_DOMAIN}/:_authToken=${NPM_TOKEN}" >> ~/.npmrc
        env:
          NPM_DOMAIN: ${{ vars.NPM_DOMAIN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Build app + Docker image (amd64 only)
        run: scripts/release.sh docker-build-release
        env:
          SKIP_ARM64_BUILD: 'true'

      - name: Docker login to Zot
        if: steps.detect.outputs.is_dry_run != 'true'
        run: docker login "${{ vars.ZOT_URL }}" -u "${{ secrets.ZOT_USERNAME }}" -p "${{ secrets.ZOT_TOKEN }}"

      - name: Tag and save release image
        if: steps.detect.outputs.is_dry_run != 'true'
        run: |
          scripts/release.sh docker-tag-version amazing-hashbrown:latest \
            "${{ vars.ZOT_URL }}/amazing-hashbrown:${{ github.ref_name }}"
          scripts/release.sh docker-save \
            "${{ vars.ZOT_URL }}/amazing-hashbrown:${{ github.ref_name }}" \
            /tmp/amazing-hashbrown.tar

      - name: Upload image tar to GitHub Release
        if: steps.detect.outputs.is_dry_run != 'true'
        run: scripts/release.sh release-upload-asset "${{ github.ref_name }}" /tmp/amazing-hashbrown.tar
        env:
          GH_TOKEN: ${{ github.token }}

      - name: Push versioned + latest tags to Zot
        if: steps.detect.outputs.is_dry_run != 'true'
        run: scripts/release.sh registry-publish "${{ vars.ZOT_URL }}/amazing-hashbrown" "${{ github.ref_name }}"
```

The build step always runs, dry run or not — that's the real validation
value of a dry run. Only the Zot/registry/release-asset steps are gated.

### 4. `.github/workflows/tests.yml`, `.github/workflows/deploy-docs.yml`

Swap the hardcoded `npm.artifacts.tdkottke.com` string in each workflow's
"Setup npmrc" step for `${{ vars.NPM_DOMAIN }}`. Same value today
(confirmed: `vars.ZOT_URL`/`vars.NPM_DOMAIN` are these same two existing
registries, now exposed as config) — this is a consistency cleanup, not a
behavior change.

`.npmrc.template` and the domain-matching `sed` pattern in
`bin/docker-build.sh` (which extracts `NPM_TOKEN` from a developer's local
`~/.npmrc`) are untouched — they're local-dev-only concerns, and the actual
host value isn't changing.

### 5. `.agents/skills/release/SKILL.md`

Rewritten to match the new shape:

- `compatibility`: drop the Docker daemon / registry login requirement —
  local now only needs git, npm, a valid npm registry token, and an
  authenticated `gh`.
- Phase list shrinks to: preflight → build-guard → bump-version →
  changelog-range → **stop and confirm** → publish. Everything docker/tar
  moves into a short "What happens after you push the tag" section pointing
  at `release.yml`.
- `changelog-range` no longer needs the "use HEAD for a dry run" special
  case — dry-run mode now always produces a real tag.
- Dry-run section rewritten around the tag-suffix mechanism: what tag name
  gets created, what CI does/doesn't do for it, and the cleanup reminder.

## Required GitHub Actions configuration (prerequisite, not code)

- `vars.ZOT_URL`, `vars.NPM_DOMAIN`
- `secrets.ZOT_USERNAME`, `secrets.ZOT_TOKEN` (basic auth against Zot)
- `secrets.NPM_TOKEN` (already exists — reused from `tests.yml`)

## Error handling

- **Local `build-guard` fails** — stop immediately, same as today. Nothing
  bumped, nothing tagged, nothing pushed.
- **CI build fails** (e.g. a Docker-specific break the lighter local guard
  didn't catch) — the tag and GitHub Release already exist publicly with no
  image behind them. Recovery is fix-forward with a new patch version, same
  "don't try to roll back already-public actions" philosophy as today's
  skill. Called out explicitly in the rewritten `SKILL.md` so it's not a
  surprise.
- **`release-upload-asset` can't find the release yet** — retries a few
  times before failing with a message naming the tag, distinguishing "still
  propagating" from "genuinely missing" (e.g. local's `publish` step was
  skipped or failed).
- **Tar near GitHub's 2GB asset limit** — keep today's warning (non-fatal),
  now surfaced in CI logs instead of a developer's terminal.
- **Zot login/push fails** — workflow fails at that step; tag + GitHub
  Release still exist, image isn't published. Same fix-forward recovery.

## Out of scope

- A `workflow_dispatch` fallback trigger to manually re-run the CI half
  against an existing tag (e.g. after fixing a transient Zot outage).
  Straightforward to add later if this comes up in practice; not needed for
  the first version.
- Publishing this application itself as an npm package — it's `private:
  true`; `NPM_DOMAIN`/`NPM_TOKEN` exist purely to authenticate `npm ci`
  during the build, same as `tests.yml` today.
- Any GitHub Environment / manual-approval gate on the CI job — the tag push
  itself is the deliberate human action that gates everything downstream.
- Auto-deleting dry-run tags after a successful test run.
