#!/usr/bin/env bash
# Downloads a GitHub Release of Amazing Hashbrown, loads it into the local
# Docker daemon, and retags it to amazing-hashbrown:<version> and
# amazing-hashbrown:latest. See docs/superpowers/specs/2026-09-11-install-script-design.md
set -euo pipefail

GITHUB_REPO="tkottke90/amazing-hashbrown"
DOCS_URL="https://tkottke90.github.io/amazing-hashbrown/docs/docker/"

usage() {
  cat <<'USAGE'
Usage: install.sh [version]

Downloads a release of Amazing Hashbrown from GitHub, loads it into the
local Docker daemon, and tags it as amazing-hashbrown:<version> and
amazing-hashbrown:latest.

Arguments:
  version     Optional. A release version, with or without a leading "v"
              (e.g. "1.5.0" or "v1.5.0"). Defaults to the latest release.

Options:
  -h, --help  Show this help message and exit.
USAGE
}

err() {
  echo "error: $*" >&2
}

if [ "$#" -gt 1 ]; then
  err "too many arguments"
  usage >&2
  exit 1
fi

TAG=""
case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  -*)
    err "unrecognized option: $1"
    usage >&2
    exit 1
    ;;
  *)
    TAG="v${1#v}"
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required but was not found on PATH. Install curl for your OS and try again."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  err "docker is required but was not found on PATH. Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  err "the Docker daemon isn't reachable. Start Docker Desktop (or dockerd) and try again."
  exit 1
fi

if [ -n "$TAG" ]; then
  api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
else
  api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
fi

echo "==> Looking up release (${TAG:-latest})..."
release_json="$(curl -fsSL "$api_url" 2>/dev/null || true)"

if [ -z "$release_json" ]; then
  err "release ${TAG:-latest} not found. See https://github.com/${GITHUB_REPO}/releases"
  exit 1
fi

tag_name="$(printf '%s' "$release_json" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
download_url="$(printf '%s' "$release_json" | grep '"browser_download_url"' | grep '\.tar"' | head -1 | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')"

if [ -z "$tag_name" ] || [ -z "$download_url" ]; then
  err "couldn't find a Docker image asset on release ${TAG:-latest}. See https://github.com/${GITHUB_REPO}/releases"
  exit 1
fi

echo "==> Found release ${tag_name}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

image_tar="${tmpdir}/image.tar"
echo "==> Downloading image for ${tag_name}..."
curl -fL --progress-bar -o "$image_tar" "$download_url"

echo "==> Loading image into Docker..."
load_output="$(docker load -i "$image_tar")"
echo "$load_output"

loaded_ref="$(printf '%s' "$load_output" | sed -n 's/^Loaded image: //p' | tail -1)"

if [ -z "$loaded_ref" ]; then
  err "couldn't determine the loaded image reference from 'docker load' output above."
  exit 1
fi

echo "==> Tagging amazing-hashbrown:${tag_name} and amazing-hashbrown:latest"
docker tag "$loaded_ref" "amazing-hashbrown:${tag_name}"
docker tag "$loaded_ref" "amazing-hashbrown:latest"

docker rmi "$loaded_ref" >/dev/null

echo ""
echo "Amazing Hashbrown ${tag_name} is ready as amazing-hashbrown:latest"
echo "Next: ${DOCS_URL}"
