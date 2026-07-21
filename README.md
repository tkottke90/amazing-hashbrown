# amazing-hashbrown

A locally-hosted LLM agent harness. It pairs a **ReAct chat agent** with a domain-organized **knowledge base** (wiki) so the agent can read, learn from, and write back to a structured body of knowledge — all running on your own machine against a local inference backend (Ollama by default).

The project is a work-in-progress. See [`TODO_LIST.md`](./TODO_LIST.md) for the current roadmap.

---

## How it works

```
Browser (Preact UI)
      │  SSE stream + REST
      ▼
Express API  ──►  LangGraph ReAct agent
                        │
              ┌─────────┼──────────┐
              ▼         ▼          ▼
         wiki tools  ask_user   upload_image
         (search,    (HITL)     (vision)
          read page)
              │
              ▼
         LLM-Wiki knowledge base
         (domain directories on disk)
```

1. The **UI** sends a message over HTTP; the API opens an SSE stream back to the browser.
2. The **LangGraph ReAct agent** reasons over the message, calling tools as needed.
3. **Wiki tools** (`wiki_search`, `wiki_read_page`) let the agent consult the local knowledge base during a turn.
4. After the response stream closes, the **AfterAgent middleware** (in progress) can commit new knowledge back to the wiki without blocking the user.
5. All LLM calls, token counts, and tool invocations are recorded to a local SQLite database by the **observability layer**.

---

## Repository structure

This is an npm-workspaces monorepo. The top-level directories are:

```
api/          Express REST API — LangGraph agent, routes, knowledge-base wiring
ui/           Preact web frontend — chat thread view, SSE event handling
e2e/          Playwright end-to-end tests
lib/
  evaluations/        Eval harness (deterministic / semantic / LLM-as-judge)
  inference-adapter/  Provider-agnostic LLM interface; Ollama implementation
  llm-common-types/   Shared Zod schemas (SSE events, chat messages, etc.)
  llm-wiki/           Domain knowledge-base library (BM25 + embedding search)
  observability/      SQLite-backed trace/span store
  rlm/                Retrieval Loop Model — iterative long-document Q&A
  skills-manager/     Skill script registry and runner
  tools-manager/      MCP tool registry, merges built-ins with MCP server tools
bin/          CLI scripts (eval runner, eval authoring tools)
docs/         Design documents and architecture notes
suites/       Eval suite YAML files (checked in)
```

Each workspace that has its own conventions carries an `AGENTS.md` — read it before editing that workspace.

---

## Prerequisites

| Requirement                  | Version | Notes                        |
| ---------------------------- | ------- | ---------------------------- |
| Node.js                      | ≥ 20    | 20 LTS or 22 LTS recommended |
| npm                          | ≥ 10    | bundled with Node            |
| [Ollama](https://ollama.com) | latest  | local inference backend      |

Pull a model before starting:

```sh
ollama pull llama3
```

Any Ollama-compatible model works. The model name is set in `.env` (`LLM_MODEL`).

---

## Dev environment setup

```sh
# 1. Clone and install
git clone https://github.com/tkottke90/amazing-hashbrown.git
cd amazing-hashbrown
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set LLM_BASE_URL and LLM_MODEL to match your Ollama setup

# 3. Start the API (watch mode, rebuilds libs first)
npm run dev:api

# 4. In a second terminal, start the UI dev server
npm run dev:ui
```

The UI dev server proxies `/api` requests to the API, so you only need to open `http://localhost:5173`.

### Environment variables

| Variable       | Default                  | Description                                       |
| -------------- | ------------------------ | ------------------------------------------------- |
| `PORT`         | `3000`                   | API server port                                   |
| `LOG_LEVEL`    | `info`                   | Pino log level (`debug`, `info`, `warn`, `error`) |
| `LLM_BASE_URL` | `http://localhost:11434` | Ollama (or compatible) base URL                   |
| `LLM_MODEL`    | `llama3`                 | Model name passed to the inference backend        |
| `WIKI_ROOT`    | `./config/kb`            | Root directory for the knowledge-base domains     |

For the full `config/config.yaml` reference (providers, embeddings, database, observability,
afterAgent, chat, cost rates), see [`docs/App-Docs/configuration.md`](./docs/App-Docs/configuration.md).

---

## Scripts

Run all scripts from the **repo root** unless noted otherwise.

### Development

```sh
npm run dev:api       # build libs then start the API in watch mode
npm run dev:ui        # start the Vite dev server (proxies /api to the API)
```

### Building

```sh
npm run build         # build libs, API, and UI for production
```

### Testing

```sh
npm test              # Mocha (API + libs) and Jest (UI) unit/integration tests
npm run test:e2e      # full Playwright suite — requires Ollama running locally
npm run test:e2e:ci   # CI-safe subset (excludes @llm-tagged tests)
```

### Quality

```sh
npm run lint          # ESLint across all workspaces
npm run format        # Prettier --write across all workspaces
npx prettier --check . # check formatting without writing (used in CI)
```

### Evaluation harness

```sh
npm run eval -- --suite wiki-search --model ollama   # run a suite
npm run eval -- --suite wiki-search --model ollama --llm-review  # + Claude Code review of the results
npm run eval:new -- --suite wiki-search              # author a new scenario
npm run eval:from-trace -- --trace-id <id> --suite wiki-search
npm run eval:review -- --run-id <id>
npm run eval:compare -- --run-a <id> --run-b <id>
```

---

## Running with Docker

The `Dockerfile` is a three-stage build that compiles both workspaces, installs production-only dependencies, and serves the built UI as static files from the API server.

```sh
docker build -t amazing-hashbrown .
docker run -p 3000:3000 \
  -e LLM_BASE_URL=http://host.docker.internal:11434 \
  -e LLM_MODEL=llama3 \
  amazing-hashbrown
```

Open `http://localhost:3000`.

---

## Contributing

### Workflow

This repository uses **Trunk Flow**: `main` is the single integration branch. All work lives on short-lived feature branches merged back to `main` via pull request.

```sh
git checkout main && git pull
git checkout -b your-feature-name
# ... make changes ...
git push -u origin your-feature-name
# open a PR targeting main
```

### Before opening a PR

All three checks must be green — CI will enforce them, so run them locally first:

```sh
npm run lint
npx prettier --check .
npm test
```

Fix any failures before committing. Do not use `--no-verify` or otherwise bypass the checks.

### Code standards

- **Tests are required.** Routes, agents, tools, services, and middleware all ship with tests. Untested code is not considered complete. See `AGENTS.md` for the full testing philosophy and type taxonomy.
- **No comments explaining _what_ the code does.** Good names do that. Only add a comment when the _why_ is non-obvious (a hidden constraint, a workaround for a specific bug).
- **No speculative abstractions.** Only add what the current task needs.

### TODO list

Outstanding work is tracked in [`TODO_LIST.md`](./TODO_LIST.md). If your branch completes an item, move it from "Outstanding" to "Completed" in that file as part of the same PR — so the list stays accurate at merge time.

### LLM-facing changes (Evaluation-Driven Development)

If your change affects agent behaviour, prompts, or tool outputs:

1. Write a failing eval scenario first (`npm run eval:new`).
2. Implement until the scenario passes.
3. The scenario must be green before the PR is merged.

See `AGENTS.md § Evaluation-Driven Development` for the full rules.
