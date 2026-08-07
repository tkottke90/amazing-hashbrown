# syntax=docker/dockerfile:1

FROM node:24
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

ARG COMMIT_SHA=unknown
ARG APP_VERSION=unknown
ENV COMMIT_SHA=$COMMIT_SHA
ENV APP_VERSION=$APP_VERSION

RUN groupadd --gid 1001 appuser \
    && useradd --uid 1001 --gid 1001 --create-home appuser


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

COPY api/dist ./api/dist
COPY ui/dist ./api/public

COPY lib/evaluations/dist ./lib/evaluations/dist
COPY lib/evaluations/templates ./lib/evaluations/templates
COPY lib/inference-adapter/dist ./lib/inference-adapter/dist
COPY lib/llm-common-types/dist ./lib/llm-common-types/dist
COPY lib/llm-wiki/dist ./lib/llm-wiki/dist
COPY lib/observability/dist ./lib/observability/dist
COPY lib/preact-dialog/dist ./lib/preact-dialog/dist
COPY lib/rlm/dist ./lib/rlm/dist
COPY lib/shell-executor/dist ./lib/shell-executor/dist
COPY lib/skills-manager/dist ./lib/skills-manager/dist
COPY lib/thread-reports/dist ./lib/thread-reports/dist
COPY lib/thread-reports/templates ./lib/thread-reports/templates
COPY lib/tools-manager/dist ./lib/tools-manager/dist

RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 3000
CMD ["node", "api/dist/index.js"]
