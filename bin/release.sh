#!/usr/bin/env bash
# Mechanical steps shared by the /release skill (local) and
# .github/workflows/release.yml (CI). Each phase is one deterministic
# unit of work so a failure always lands on a clearly-named step instead of
# partway through a wall of inline commands. The changelog itself is NOT
# written here — that needs judgment, so `changelog-range` only gathers the
# raw material and the skill (Claude) drafts the prose.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_IMAGE="amazing-hashbrown:latest"

run() {
  if [ "${DRY_RUN:-false}" = "true" ]; then
    echo "[dry-run] would run: $*"
  else
    echo "==> $*"
    "$@"
  fi
}

# Single source of truth for the dry-run/test tag suffix. Anchored at the
# end with a required trailing digit run so it can never match a real
# prerelease tag like v1.2.0-alpha, v1.2.0-beta.2, or v1.2.0-rc.1.
is_dry_run_tag() {
  [[ "$1" =~ -(dry-run|test)-[0-9]+$ ]]
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
  branch=$(git rev-parse --abbrev-ref HEAD)
  echo "BRANCH=$branch"
  if [ "$branch" != "main" ]; then
    echo "FAIL: releases must be cut from main (current branch: $branch)" >&2
    fail=1
  fi
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
  run npm run build
  echo "OK: build guard passed (npm run build succeeded)"
  ;;

bump-version)
  bump="${1:?usage: bump-version <major|minor|patch|x.y.z> [--dry-run]}"
  dry="${2:-}"
  if [ "$dry" = "--dry-run" ]; then
    new_version=$(node -e '
      const fs = require("fs");
      const bump = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      if (/^\d+\.\d+\.\d+/.test(bump)) {
        console.log(bump.replace(/^v/, ""));
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
      console.log(table[bump]);
    ' "$bump")
    new_tag="v${new_version}-dry-run-$(date +%s)"
    git tag "$new_tag"
    echo "NEW_TAG=$new_tag"
    echo "NEW_VERSION=$new_version"
  else
    new_tag=$(npm version "$bump")
    echo "NEW_TAG=$new_tag"
    echo "NEW_VERSION=${new_tag#v}"
  fi
  ;;

detect-dry-run)
  tag="${1:?usage: detect-dry-run <tag>}"
  if is_dry_run_tag "$tag"; then
    echo "is_dry_run=true"
  else
    echo "is_dry_run=false"
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
  # new_ref is the tag to diff up to — always a real tag now, dry runs
  # included (bump-version --dry-run creates a real, suffixed tag; see
  # is_dry_run_tag).
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

release-upload-asset)
  tag="${1:?usage: release-upload-asset <tag> <tarfile>}"
  tarfile="${2:?usage: release-upload-asset <tag> <tarfile>}"
  attempts=6
  delay=5
  for i in $(seq 1 "$attempts"); do
    if gh release upload "$tag" "$tarfile" --clobber; then
      echo "OK: uploaded $tarfile to release $tag"
      exit 0
    fi
    echo "release $tag not found yet (attempt $i/$attempts), retrying in ${delay}s..." >&2
    sleep "$delay"
  done
  echo "FAIL: no release found for tag $tag after $attempts attempts" >&2
  exit 1
  ;;

registry-publish)
  image_base="${1:?usage: registry-publish <image-base> <tag>}"
  tag="${2:?usage: registry-publish <image-base> <tag>}"
  run docker tag "${image_base}:${tag}" "${image_base}:latest"
  run docker push "${image_base}:${tag}"
  run docker push "${image_base}:latest"
  ;;

publish)
  tag="${1:?usage: publish <tag> <changelog-file>}"
  changelog_file="${2:?usage: publish <tag> <changelog-file>}"
  branch=$(git rev-parse --abbrev-ref HEAD)

  run git push origin "$branch"
  run git push origin "$tag"
  if is_dry_run_tag "$tag"; then
    echo "SKIP: dry-run tag $tag — not creating a GitHub Release"
  else
    run gh release create "$tag" --title "$tag" --notes-file "$changelog_file"
  fi
  ;;

*)
  echo "usage: release.sh <preflight|pkg-info|build-guard|bump-version|detect-dry-run|docker-build-release|docker-tag-version|docker-save|changelog-range|release-upload-asset|registry-publish|publish> [args...]" >&2
  exit 1
  ;;

esac
