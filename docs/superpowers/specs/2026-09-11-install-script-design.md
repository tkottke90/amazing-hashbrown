# Install Script (`scripts/install.sh`) — Design

**Date:** 2026-09-11
**Status:** Approved

---

## Overview

[002-quick-start.md](../../../docs-site/content/docs/002-quick-start.md) already
tells users to run:

```sh
curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | sh
```

but that script doesn't exist yet. This design specifies it: a small bash
script that gets a user from "nothing installed" to a locally-loaded,
correctly-tagged `amazing-hashbrown:latest` Docker image, ready for the
[Docker docs page](../../../docs-site/content/docs/003-docker.md)'s `docker
run` / Compose steps. It does not start the container itself — that stays a
manual step on the Docker page, since port/volume/config choices belong
there, not baked into an install script.

**Why this is needed:** the release pipeline (`.agents/skills/release/scripts/release.sh`)
tags the image with the maintainer's private registry host and a `v`-prefixed
version (`docker.artifacts.tdkottke.com/amazing-hashbrown:v1.7.0`) before
saving it into the GitHub Release tarball. A plain `docker load` therefore
restores the image under that long private name, not the short
`amazing-hashbrown:latest` the rest of the docs assume. This script automates
the fetch + retag + cleanup that a user would otherwise have to do by hand
(as currently documented as a manual fallback on the Docker page).

**Explicitly out of scope:**

- Running the container (`docker run`/`docker compose up`) — stays manual, on
  the Docker docs page.
- Any config-file scaffolding (`config.yaml`, bind-mount ownership) — also
  stays on the Docker docs page.
- Supporting any repo other than `tkottke90/amazing-hashbrown` — hardcoded,
  matching how `release.sh` already hardcodes this project's registry host
  and repo specifics. No env-var override; add one later if this script is
  ever reused elsewhere.
- Uninstall/rollback tooling.

---

## CLI Interface

```
scripts/install.sh [version]
scripts/install.sh -h | --help
```

- **No argument:** installs the latest GitHub Release.
- **One argument:** a version, accepted with or without a leading `v`
  (`1.5.0` or `v1.5.0`) — normalized internally to the canonical `vX.Y.Z`
  git-tag form before querying GitHub.
- **More than one argument, or an unrecognized flag:** usage error, exit 1.
- **`-h`/`--help`:** prints usage, exits 0, no side effects.

Piped form (updated in Quick Start, see "Documentation Updates" below):

```sh
curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/tkottke90/amazing-hashbrown/main/scripts/install.sh | bash -s -- v1.5.0
```

**Shell target: bash, not POSIX `sh`.** Piping into `sh` strips the shebang
entirely — the interpreter is whatever `sh` resolves to (`dash` on most
Linux), which doesn't support `pipefail`, and the rest of this repo's
scripts (`release.sh`, `docker-build.sh`) already assume bash. The Quick
Start doc's curl command changes from `| sh` to `| bash` as part of this
work, rather than writing this script to the lowest-common-denominator POSIX
subset with no precedent elsewhere in the repo.

`GITHUB_REPO="tkottke90/amazing-hashbrown"` is a hardcoded constant at the
top of the script (not configurable — see "out of scope" above).

---

## Flow

1. **Parse args.** Extract the optional version argument; normalize a
   leading-`v`-optional input to `vX.Y.Z`. Handle `-h`/`--help` and arg-count
   errors here, before anything else runs.

2. **Preflight checks.** Verify `curl` and `docker` are on `PATH`, and that
   `docker info` succeeds (daemon reachable). Fail fast with a specific,
   actionable message per missing piece — don't bundle these into one vague
   "missing dependency" error.

3. **Resolve the release.** Query the GitHub API, unauthenticated (public
   repo, no token needed):
   - No version given: `GET /repos/$GITHUB_REPO/releases/latest`
   - Version given: `GET /repos/$GITHUB_REPO/releases/tags/$TAG`

   From the JSON response, extract:
   - `tag_name` (used for user-facing messaging and the normalized version
     label — not for constructing the private-registry tag; see step 5).
   - The `browser_download_url` of the asset whose `name` ends in `.tar`
     (the release process attaches exactly one such asset per release).

   No `jq` dependency — extraction uses `grep`/`sed` against GitHub's
   pretty-printed (one-field-per-line) JSON:

   ```sh
   tag_name=$(printf '%s' "$json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
   download_url=$(printf '%s' "$json" | grep '"browser_download_url"' | grep '\.tar"' | head -1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')
   ```

   If the API call fails (404, or no matching asset found in a successful
   response), exit 1 with a message pointing at
   `https://github.com/$GITHUB_REPO/releases` rather than guessing further.

4. **Download.** `mktemp -d` for a scratch directory; `trap` its removal on
   `EXIT` so cleanup happens on every exit path, success or failure.
   Download with a progress bar (`curl -fL --progress-bar -o
   "$tmpdir/image.tar" "$download_url"`) — these are full Docker image
   tarballs, likely hundreds of MB, so silent download progress would be a
   poor experience.

5. **Load.** Run `docker load -i "$tmpdir/image.tar"` and capture its
   stdout. Docker prints a line like `Loaded image:
   docker.artifacts.tdkottke.com/amazing-hashbrown:v1.7.0` — parse *that*
   line for the loaded image reference rather than reconstructing the
   private-registry tag from assumptions about `release.sh`'s naming
   convention. This is a deliberate robustness choice: if the release
   pipeline's tag format ever changes, this script keeps working unchanged.

6. **Retag.**
   ```sh
   docker tag "$loaded_ref" "amazing-hashbrown:$tag_name"   # e.g. amazing-hashbrown:v1.7.0
   docker tag "$loaded_ref" "amazing-hashbrown:latest"
   ```

7. **Clean up the private tag.** `docker rmi "$loaded_ref"` — this removes
   only that tag reference; the underlying image layers stay, since the two
   tags created in step 6 still point to them.

8. **Report success.** Print the installed version and a pointer to the
   Docker docs page (`https://tkottke90.github.io/amazing-hashbrown/docs/docker/`)
   as the next step.

---

## Error Handling

Every failure path exits non-zero with a message on stderr specific enough
to act on — no generic "something went wrong":

| Condition | Message |
|---|---|
| `curl` not found | Install curl, with a pointer to the OS-appropriate install method |
| `docker` not found | Install Docker, with a pointer to docker.com |
| `docker info` fails | Docker daemon isn't running — start Docker Desktop / `dockerd` |
| Release/tag not found (API 404) | Named version doesn't exist; link to the releases page |
| No `.tar` asset in an otherwise-valid release response | Release is missing its image artifact; link to the releases page (this indicates a broken release, not user error, but there's nothing else to do locally) |
| Download fails (`curl -f` non-2xx, network error) | Let curl's own stderr surface via `set -euo pipefail`; don't swallow it |
| `docker load` fails (corrupt tar, disk space) | Let Docker's own stderr surface the same way |
| Unrecognized args / too many args | Usage message, matching `-h`/`--help` output |

`set -euo pipefail` at the top of the script, consistent with `release.sh`
and `docker-build.sh`.

---

## Documentation Updates

**[002-quick-start.md](../../../docs-site/content/docs/002-quick-start.md):**
- `| sh` → `| bash` in the curl command.
- Remove "and start the application" from the description — the script
  stops once the image is loaded and tagged. Replace with a pointer to the
  Docker docs page as the next step.
- Add a one-line mention of pinning a version:
  `curl ... | bash -s -- v1.5.0`.

**[003-docker.md](../../../docs-site/content/docs/003-docker.md):**
- The current "Image Required" note explains a *manual* `docker tag` fix for
  people who already loaded the image by hand. Reframe it to lead with "run
  the install script from Quick Start if you haven't" and keep the existing
  manual retag steps as a documented fallback for people who deviate from
  that path (e.g. an air-gapped environment, or a tarball obtained by other
  means).

---

## Testing Plan

No automated test suite for this script (it's a thin orchestration of
`curl`/`docker`/GitHub's API, not app logic) — validated manually:

- Run with no argument against a real, current release; confirm
  `docker images` shows `amazing-hashbrown:vX.Y.Z` and `amazing-hashbrown:latest`,
  and that no `docker.artifacts.tdkottke.com/...` tag remains.
- Run with an explicit older version (both `1.x.y` and `v1.x.y` forms);
  confirm the same outcome for that version.
- Run with a nonexistent version; confirm a clear error and non-zero exit,
  not a stack of raw curl/API noise.
- Run with the Docker daemon stopped; confirm the preflight check catches it
  before any network activity.
- Run with `docker`/`curl` temporarily hidden from `PATH`; confirm the
  preflight check names the specific missing tool.
- `shellcheck scripts/install.sh` clean (or explicit, justified disables).
