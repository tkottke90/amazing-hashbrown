# syntax=docker/dockerfile:1

# ---- deps: install production node_modules (needs the full toolchain in
# case a native module like better-sqlite3 has to compile from source) ----
FROM node:24 AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY ui/package.json ./ui/package.json
COPY e2e/package.json ./e2e/package.json
COPY lib/evaluations/package.json ./lib/evaluations/package.json
COPY lib/inference-adapter/package.json ./lib/inference-adapter/package.json
COPY lib/llm-common-types/package.json ./lib/llm-common-types/package.json
COPY lib/llm-wiki/package.json ./lib/llm-wiki/package.json
COPY lib/observability/package.json ./lib/observability/package.json
COPY lib/preact-dialog/package.json ./lib/preact-dialog/package.json
COPY lib/rlm/package.json ./lib/rlm/package.json
COPY lib/shell-executor/package.json ./lib/shell-executor/package.json
COPY lib/skills-manager/package.json ./lib/skills-manager/package.json
COPY lib/thread-reports/package.json ./lib/thread-reports/package.json
COPY lib/tools-manager/package.json ./lib/tools-manager/package.json

# Copy the template file into the image
COPY .npmrc.template ./

# 1. Mount the secret token safely
# 2. Use envsubst to replace the placeholder with the real token
# 3. Run the installer and immediately delete the generated .npmrc
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) \
    node -e "const fs = require('fs'); const tpl = fs.readFileSync('.npmrc.template', 'utf8'); fs.writeFileSync('.npmrc', tpl.replace('\${NPM_TOKEN}', process.env.NPM_TOKEN));" && \
    npm ci --omit dev && \
    rm -f .npmrc .npmrc.template && \
    npm cache clean --force

# ---- runtime: lean image — no compiler toolchain, no git/mercurial/svn
# from the full node image, just what the running app and its shell-exec /
# MCP tooling actually need ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

ARG COMMIT_SHA=unknown
ARG APP_VERSION=unknown
ENV COMMIT_SHA=$COMMIT_SHA
ENV APP_VERSION=$APP_VERSION

# unzip: optional .zip support for wiki uploads (tar/tgz work without it)
# git, curl, python3: available to the agent's shell-exec tool
# uv/uvx: Python-based skills and MCP servers launched via uvx
# gh: GitHub CLI, installed from GitHub's own apt repo (not in Debian's)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates unzip git curl python3 gnupg \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --create-home appuser \
    && chown appuser:appuser /app

COPY --from=deps --chown=appuser:appuser /app/node_modules ./node_modules

COPY --chown=appuser:appuser package.json ./package.json
COPY --chown=appuser:appuser api/package.json ./api/package.json
COPY --chown=appuser:appuser api/dist ./api/dist
COPY --chown=appuser:appuser ui/dist ./api/public

COPY --chown=appuser:appuser lib/evaluations/package.json ./lib/evaluations/package.json
COPY --chown=appuser:appuser lib/evaluations/dist ./lib/evaluations/dist
COPY --chown=appuser:appuser lib/evaluations/templates ./lib/evaluations/templates
COPY --chown=appuser:appuser lib/inference-adapter/package.json ./lib/inference-adapter/package.json
COPY --chown=appuser:appuser lib/inference-adapter/dist ./lib/inference-adapter/dist
COPY --chown=appuser:appuser lib/llm-common-types/package.json ./lib/llm-common-types/package.json
COPY --chown=appuser:appuser lib/llm-common-types/dist ./lib/llm-common-types/dist
COPY --chown=appuser:appuser lib/llm-wiki/package.json ./lib/llm-wiki/package.json
COPY --chown=appuser:appuser lib/llm-wiki/dist ./lib/llm-wiki/dist
COPY --chown=appuser:appuser lib/observability/package.json ./lib/observability/package.json
COPY --chown=appuser:appuser lib/observability/dist ./lib/observability/dist
COPY --chown=appuser:appuser lib/preact-dialog/package.json ./lib/preact-dialog/package.json
COPY --chown=appuser:appuser lib/preact-dialog/dist ./lib/preact-dialog/dist
COPY --chown=appuser:appuser lib/rlm/package.json ./lib/rlm/package.json
COPY --chown=appuser:appuser lib/rlm/dist ./lib/rlm/dist
COPY --chown=appuser:appuser lib/shell-executor/package.json ./lib/shell-executor/package.json
COPY --chown=appuser:appuser lib/shell-executor/dist ./lib/shell-executor/dist
COPY --chown=appuser:appuser lib/skills-manager/package.json ./lib/skills-manager/package.json
COPY --chown=appuser:appuser lib/skills-manager/dist ./lib/skills-manager/dist
COPY --chown=appuser:appuser lib/thread-reports/package.json ./lib/thread-reports/package.json
COPY --chown=appuser:appuser lib/thread-reports/dist ./lib/thread-reports/dist
COPY --chown=appuser:appuser lib/thread-reports/templates ./lib/thread-reports/templates
COPY --chown=appuser:appuser lib/tools-manager/package.json ./lib/tools-manager/package.json
COPY --chown=appuser:appuser lib/tools-manager/dist ./lib/tools-manager/dist

USER appuser
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
