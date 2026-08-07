#!/usr/bin/env bash
# Mechanical steps for the /release skill. Each phase is one deterministic
# unit of work so a failure always lands on a clearly-named step instead of
# partway through a wall of inline commands. The changelog itself is NOT
# written here — that needs judgment, so `changelog-range` only gathers the
# raw material and the skill (Claude) drafts the prose.
set -euo pipefail
cd "$(dirname "$0")/../../../.."

REGISTRY_HOST="docker.artifacts.tdkottke.com"
APP_IMAGE="amazing-hashbrown:latest"

run() {
  if [ "${DRY_RUN:-false}" = "true" ]; then
    echo "[dry-run] would run: $*"
  else
    echo "==> $*"
    "$@"
  fi
}

phase="${1:-}"
shift || true

case "$phase" in

preflight)
  fail=0
  if [ -n "$(git status --porcelain)" ]; then
    echo "FAIL: working tree is not clean — commit or stash changes first" >&2
    fail=1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "FAIL: gh CLI is not authenticated — run 'gh auth login'" >&2
    fail=1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "FAIL: docker daemon is not running" >&2
    fail=1
  fi
  if ! grep -q "\"$REGISTRY_HOST\"" "$HOME/.docker/config.json" 2>/dev/null; then
    echo "FAIL: not logged into $REGISTRY_HOST — run 'docker login $REGISTRY_HOST'" >&2
    fail=1
  fi
  branch=$(git rev-parse --abbrev-ref HEAD)
  echo "BRANCH=$branch"
  if [ "$fail" = "1" ]; then
    exit 1
  fi
  echo "OK: preflight checks passed"
  ;;

pkg-info)
  node -e '
    const pkg = require("./package.json");
    console.log(`NAME=${pkg.name}`);
    console.log(`CURRENT_VERSION=${pkg.version}`);
  '
  ;;

build-guard)
  run npm run build:app
  echo "OK: build guard passed (npm run build:app succeeded, image: $APP_IMAGE)"
  ;;

bump-version)
  bump="${1:?usage: bump-version <major|minor|patch|x.y.z> [--dry-run]}"
  dry="${2:-}"
  if [ "$dry" = "--dry-run" ]; then
    node -e '
      const fs = require("fs");
      const bump = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      if (/^\d+\.\d+\.\d+/.test(bump)) {
        console.log(`NEW_VERSION=${bump.replace(/^v/, "")}`);
        process.exit(0);
      }
      const [maj, min, pat] = pkg.version.split(".").map(Number);
      const table = {
        major: `${maj + 1}.0.0`,
        minor: `${maj}.${min + 1}.0`,
        patch: `${maj}.${min}.${pat + 1}`,
      };
      if (!table[bump]) {
        console.error(`unknown bump type: ${bump}`);
        process.exit(1);
      }
      console.log(`NEW_VERSION=${table[bump]}`);
    ' "$bump"
    echo "NEW_TAG=(skipped in dry-run — no git tag created)"
  else
    new_tag=$(npm version "$bump")
    echo "NEW_TAG=$new_tag"
    echo "NEW_VERSION=${new_tag#v}"
  fi
  ;;

docker-build-release)
  # npm run build:app reads COMMIT_SHA/APP_VERSION straight from the current
  # git HEAD and package.json, so this must run after bump-version has
  # committed the version bump — it picks up the real release version.
  run npm run build:app
  echo "OK: docker-build-release passed (image: $APP_IMAGE)"
  ;;

docker-tag-version)
  src="${1:?usage: docker-tag-version <src-image> <dest-image>}"
  dest="${2:?usage: docker-tag-version <src-image> <dest-image>}"
  run docker tag "$src" "$dest"
  ;;

docker-save)
  image="${1:?usage: docker-save <image:tag> <outfile>}"
  outfile="${2:?usage: docker-save <image:tag> <outfile>}"
  run docker save -o "$outfile" "$image"
  size_bytes=$(stat -f%z "$outfile" 2>/dev/null || stat -c%s "$outfile" 2>/dev/null || echo 0)
  echo "OK: saved $image to $outfile ($(du -h "$outfile" 2>/dev/null | cut -f1))"
  # GitHub release assets are capped at 2GB per file; warn with room to act.
  if [ "$size_bytes" -gt 1800000000 ]; then
    echo "WARN: tar is $(du -h "$outfile" | cut -f1) — close to or over GitHub's 2GB release asset limit" >&2
  fi
  ;;

changelog-range)
  # new_ref is either a real tag (real run) or "HEAD" (dry run, tag doesn't exist yet)
  new_ref="${1:?usage: changelog-range <new-tag-or-HEAD>}"
  prev_tag=$(git tag --list --sort=-v:refname | grep -v -x "$new_ref" | head -1 || true)
  if [ -z "$prev_tag" ]; then
    echo "PREV_TAG=(none — first release, covering full history)"
    echo "--- commits ---"
    git log --oneline "$new_ref"
  else
    echo "PREV_TAG=$prev_tag"
    echo "--- commits ${prev_tag}..${new_ref} ---"
    git log --oneline "${prev_tag}..${new_ref}"
  fi
  ;;

publish)
  tag="${1:?usage: publish <tag> <registry-image-base> <version> <tarfile> <changelog-file> [--dry-run]}"
  registry_image="${2:?}"
  version="${3:?}"
  tarfile="${4:?}"
  changelog_file="${5:?}"
  dry="${6:-}"
  export DRY_RUN="false"
  if [ "$dry" = "--dry-run" ]; then
    export DRY_RUN="true"
  fi
  branch=$(git rev-parse --abbrev-ref HEAD)

  run git push origin "$branch"
  run git push origin "$tag"
  run gh release create "$tag" "$tarfile" --title "$tag" --notes-file "$changelog_file"
  run docker tag "${registry_image}:v${version}" "${registry_image}:latest"
  run docker push "${registry_image}:v${version}"
  run docker push "${registry_image}:latest"
  ;;

*)
  echo "usage: release.sh <preflight|pkg-info|build-guard|bump-version|docker-build-release|docker-tag-version|docker-save|changelog-range|publish> [args...]" >&2
  exit 1
  ;;

esac
