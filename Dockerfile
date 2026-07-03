# syntax=docker/dockerfile:1

# ---- build: compile the api and ui workspaces ----
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY ui/package.json ./ui/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---- prod-deps: production-only node_modules ----
FROM node:24 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY ui/package.json ./ui/package.json
RUN npm ci --omit dev

# ---- runtime: assemble the final image ----
FROM node:24 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY api/package.json ./api/package.json
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/ui/dist ./api/public

EXPOSE 3000
CMD ["node", "api/dist/index.js"]
