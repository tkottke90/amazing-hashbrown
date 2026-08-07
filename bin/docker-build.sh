#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMMIT_SHA=$(git rev-parse HEAD)
APP_VERSION=$(node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('package.json')).version)")

npm run build

docker build \
  -t amazing-hashbrown \
  --build-arg COMMIT_SHA="$COMMIT_SHA" \
  --build-arg APP_VERSION="$APP_VERSION" \
  .
