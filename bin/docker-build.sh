#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

COMMIT_SHA=$(git rev-parse HEAD)
APP_VERSION=$(node -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('package.json')).version)")
export NPM_TOKEN=$(sed -n 's#.*//npm\.artifacts\.tdkottke\.com/:_authToken=##p' ~/.npmrc | head -1)

if [ -z "$NPM_TOKEN" ]; then
  echo "error: no npm.artifacts.tdkottke.com auth token found in ~/.npmrc — run 'npm login --registry=https://npm.artifacts.tdkottke.com/'" >&2
  exit 1
fi

npm run build

docker build \
  -t amazing-hashbrown \
  --secret id=npm_token,env=NPM_TOKEN \
  --build-arg COMMIT_SHA="$COMMIT_SHA" \
  --build-arg APP_VERSION="$APP_VERSION" \
  .
