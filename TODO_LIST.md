# TODO List

## 1. Completed Items

1. [Connect Tools Manager to Chat Agent](#connect-tools-manager-to-chat-agent) — unlocks MCP tool support; no dependencies
2. [Automated E2E Tests](#automated-e2e-tests) — Playwright test suite covering key user flows; LLM-dependent tests tagged and skipped in CI
3. [File-based Configuration](#file-based-configuration) — `config.yaml` as primary config source; `${ENV_VAR}` interpolation; auto-created on first run; `POST /api/v1/settings/reload` endpoint
4. [Provider Registration](#provider-registration) — `providers[]` config block; `createProvider()` factory for Ollama/OpenAI/Anthropic; `GET /api/v1/providers` endpoint; legacy `llmBaseUrl`/`llmModel` fields removed
5. [Observability](#observability) — `lib/observability` library with SQLite-backed trace/span store; LangChain callback handler; `/v1/traces` REST endpoints; shared `openDatabase()` connection factory

---

## 2. Outstanding Items

Items are ordered first by priority/necessity, then by dependency.

1. [Usage and Cost Tracking](#usage-and-cost-tracking) — depends on: Provider Registration; per-provider cost metrics with configurable pricing
2. [Wire Up Domain Knowledge Bases](#wire-up-domain-knowledge-bases) — prerequisite for all knowledge features
3. [Evaluation Harness](#evaluation-harness) — no dependencies; dual-use dev and production model comparison; enables TDD for #5
4. [`wiki_updated` SSE Event](#wiki_updated-sse-event) — type-level change; required before wiki middleware is visible in the UI
5. [Connect LLM-Wiki to Chat Agent](#connect-llm-wiki-to-chat-agent) — depends on: #2, #4; first feature with eval coverage (#3)
6. [AfterAgent Middleware](#afteragent-middleware) — depends on: #5; closes the conversational wiki-write loop
7. [Persistent Conversation Memory](#persistent-conversation-memory) — establishes SQLite as the shared persistence layer; completes the v1 conversational product
8. [Persistent Artifact Store](#persistent-artifact-store) — shared storage for uploaded files and agent-generated artifacts; pairs with #7 as a persistence sprint
9. [Wiki Orient Tool (`wiki.orient()`)](#wiki-orient-tool-wikiorient) — depends on: #5; required for automated tasks
10. [Wiki Write Tooling](#wiki-write-tooling) — depends on: #5; unified write/commit tools used by all agent patterns
11. [Wiki Lint Tool (`wiki.lint()`)](#wiki-lint-tool-wikilint) — depends on: #5; required for automated tasks
12. [Web/URL Ingestion Tool](#weburl-ingestion-tool) — depends on: #5; required for automated task knowledge gaps
13. [Connect RLM to Chat Agent](#connect-rlm-to-chat-agent) — depends on: #5
14. [Task System](#task-system) — depends on: #7; foundational for all autonomous operation; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
15. [Thread Type 2: Automated Task](#thread-type-2-automated-task) — depends on: #9, #10, #11, #12, #13, #14
16. [Trigger System](#trigger-system) — depends on: #14; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
17. [Escalation System](#escalation-system) — depends on: #14; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
18. [Dashboard System](#dashboard-system) — depends on: #14, #17; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
19. [Multi-Conversation Support](#multi-conversation-support) — depends on: #7
20. [File Attachment in Chat Input](#file-attachment-in-chat-input) — depends on: #8; UI wiring already stubbed
21. [Settings Page UI](#settings-page-ui) — sidebar nav link is currently a `#` stub
22. [Skills Integration](#skills-integration) — depends on: #21; `skills-manager` library is complete; needs API + UI
23. [MCP Tool Configuration UI](#mcp-tool-configuration-ui) — depends on: #21
24. [Home / Conversation List Page](#home--conversation-list-page) — depends on: #19
25. [Notification Delivery](#notification-delivery) — depends on: #17; external channels deferred; interim: `action_required` flag on threads/tasks

---

## 3. Item Details

### Automated E2E Tests

**Goal:** Add a Playwright-based end-to-end test suite that exercises key user flows against a running instance of the application, so new features can be verified automatically as they are built.

**Ideas / Requirements:**

- New `e2e/` workspace at the repo root with `playwright.config.ts`
- Playwright's built-in `webServer` option starts the API and UI dev servers before the suite runs
- Tests that require the LLM (chat flows, HITL, tool calls) are tagged (e.g. `@llm`) and excluded from the CI run via a `--grep-invert` flag; they run locally against a live Ollama instance
- CI runs only the non-LLM subset: page load, navigation, health check, static UI interactions
- A new `e2e` job in `.github/workflows/tests.yml` runs the CI-safe subset on every PR
- Add `npm run test:e2e` (full suite, local only) and `npm run test:e2e:ci` (tagged subset, CI-safe) to the root `package.json`

---

### AfterAgent Middleware

**Goal:** Run a background post-response layer that detects novel knowledge surfaced during a conversational turn and commits it to the wiki without blocking the user's response.

**Ideas / Requirements:**

- Implemented as Express middleware (or a LangGraph post-step hook) that fires **after** the SSE response stream closes
- Inspect the completed turn's tool call outputs for a "wiki write" signal (e.g. a flag set by the agent on the `upload_image` or a dedicated `flag_for_wiki` tool)
- If signalled: call `wiki.ingestPrep({ content, title })` then `wiki.commitPage(page)` in the background
- Emit a `wiki_updated` SSE event on the **next** response or via a persistent notification channel so the UI can show a subtle "wiki updated" indicator
- Must not block or error the main response — wrap in try/catch, log failures
- The wiki is **read-only during the turn itself**; this middleware is the only write path for Thread Type 1

**Dependencies:** Connect LLM-Wiki to Chat Agent, `wiki_updated` SSE Event

---

### Connect LLM-Wiki to Chat Agent

**Goal:** Expose the knowledge base as a tool the LangGraph ReAct agent can read from and write to during conversations.

**Ideas / Requirements:**

- Add `wiki_search` and `wiki_read_page` tools in `api/src/agents/tools/` using `@tkottke90/llm-wiki`
- `wiki_search` performs hybrid BM25 + embedding search and returns ranked results with page paths
- `wiki_read_page` accepts a page path and returns the full content for short pages
- The wiki root should be configured via the existing `WIKI_ROOT` env var
- Tools should handle errors gracefully (wiki not initialised, embedding provider unavailable, etc.)
- Write access is intentionally deferred — the AfterAgent Middleware owns wiki writes for Thread Type 1

**Dependencies:** Wire Up Domain Knowledge Bases, `wiki_updated` SSE Event

---

### Connect RLM to Chat Agent

**Goal:** Let the agent use the Retrieval Loop Model engine to answer questions over pages too large to fit in the model's context window.

**Ideas / Requirements:**

- Add an `rlm_query` tool in `api/src/agents/tools/` that accepts a natural-language question and a page path
- The tool passes the page content to `rlm.run(question, { text: page.content })` — matching the flow in the design doc
- Stream `StatusSignal` callbacks back to the SSE layer so the UI can show progress (e.g. "Searching… iteration 3/10")
- Consider emitting intermediate `tool_call_start` / `tool_call_end` events per RLM iteration for transparency
- Cap `maxIterations` via env var (e.g. `RLM_MAX_ITERATIONS`, default 10)

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Connect Tools Manager to Chat Agent

**Goal:** Replace the hard-coded `[askUserTool, uploadImageTool]` tool list in `chat-agent.ts` with the unified `ToolsManager` registry so MCP tools are available automatically.

**Ideas / Requirements:**

- Call `toolsManager.getTools()` at agent build time and merge with built-in tools
- Ensure `ask_user` and `upload_image` remain registered as built-in tools in the manager
- Hot-reload: if `mcp.json` changes on disk, rebuild the agent (or signal the user to restart)
- Add an `MCP_CONFIG_PATH` env var defaulting to `./config/mcp.json`
- Handle the case where an MCP server is unreachable at startup (warn, don't crash)

---

### Dashboard System

**Goal:** Provide a runtime for agent-published widgets so the agent can communicate asynchronously with the user through persistent, data-driven UI components rather than interrupting notifications.

**Design origin:** [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md) — Monitoring & Dashboards

**Ideas / Requirements:**

- Agents emit widget definitions as a byproduct of working; the system renders and refreshes them in the UI
- A widget is a self-contained unit: a question the agent knows how to answer, a data payload, and a display hint
- Widget examples: "3 tasks completed overnight, 1 waiting for input"; "Wiki: 47 pages, last updated 2h ago, 2 lint warnings"; "Inbox quiet on Project X for 3 days — unusual given last week's pace"
- The dashboard is the **Inform tier** of the escalation spectrum rendered as a persistent artifact rather than a one-time notification
- Widgets should be queryable and updatable independently — agents don't re-emit the whole dashboard, just the widgets they own
- Consider a `POST /api/v1/widgets` endpoint that tasks/agents write to, and a `GET /api/v1/widgets` that the UI polls or subscribes to
- The UI surface could be an expandable panel, a sidebar section, or a dedicated `/dashboard` route
- Agents define their own widgets — the user does not configure them manually

**Dependencies:** Task System, Escalation System

---

### Escalation System

**Goal:** Determine the appropriate tier of the escalation spectrum for any given agent communication and route it to the correct delivery channel based on urgency and user availability.

**Design origin:** [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md) — The Escalation Spectrum

**Ideas / Requirements:**

- Four tiers: **Inform** (dashboard widget), **Confirm** (soft notification with undo window), **Decide** (active HITL prompt, blocks agent), **Escalate** (interrupt regardless of availability)
- The existing HITL mechanism covers Decide; this system wraps and extends it to cover all four tiers
- Tier selection criteria: reversibility of the action, cost of being wrong, whether the task can continue without input
- User availability model: at minimum a manual "do not disturb" schedule; ideally inferred from activity or calendar
- Confirm tier needs an undo window — agent commits but notifies the user with a time-limited rollback option
- Escalate tier needs a push channel (browser notification, email, or future mobile notification) that works when the user is not in the UI
- The system should log all escalation events so the user can review what happened and why
- **Interim delivery mechanism:** until Notification Delivery (#28) is built, the Escalation System sets `action_required: true` on the relevant thread or task record; the UI surfaces flagged items prominently (badge, pinned to top of conversation list) — covers the critical user-facing need without requiring an external channel

**Dependencies:** Task System

---

### File-based Configuration

**Goal:** Introduce a `config.yaml` as the primary configuration source for the API so users can set values without editing `.env` files. Environment variables remain valid and take precedence as overrides, which the existing `@tkottke90/config-manager` already supports.

**Ideas / Requirements:**

- Add a `config.yaml` (or `config.yml`) at a configurable path (env var `CONFIG_PATH`, default `./config/config.yaml`) loaded before the Zod schema is validated
- `src/config/env.ts` reads the file first, then merges env vars on top — env vars win on conflict
- The file is created with documented defaults if it does not exist at startup (same pattern as `mcp.json`)
- `config.yaml` is `.gitignore`d so local overrides never reach the repo; a committed `config.yaml.example` documents all supported keys
- All values currently driven by env vars (port, log level, LLM model, LLM base URL, wiki root, MCP config path) should be expressible in the file
- `app.config` (the `ConfigManager` instance on the Express app) exposes a `reload()` method — a `POST /api/v1/settings/reload` endpoint can trigger a live config reload without restart
- This is a prerequisite for Provider Registration (#2) and the Settings Page UI (#24), both of which need structured config sections beyond what flat env vars can cleanly express

---

### Evaluation Harness

**Goal:** Provide a standardized, dual-use evaluation framework that works during development (TDD, CI gates) and in production (model comparison, regression detection) without coupling to any test runner.

**Ideas / Requirements:**

- New package: `lib/evaluations` — zero test-framework dependencies; callable from API routes, CLI scripts, or test suites equally
- **Scenario schema** (Zod): `{ id, name, description, input, evalMethod, expectedCriteria, minScore? }`
- **Result schema** (Zod): `{ scenarioId, model, modelVersion, suiteId, timestamp, passed, score, latencyMs, estimatedCost, details }`
- Three eval methods:
  - **Deterministic**: predicate function or exact match on structured output — pass/fail, no scoring variance
  - **Semantic**: embedding similarity between actual output and expected content — returns 0.0–1.0
  - **LLM-as-judge**: a judge prompt with a structured verdict schema — returns score + reasoning string
- **Suites** are named collections of scenarios grouped by feature area (e.g. `wiki-search`, `agent-routing`, `escalation`); each suite carries an optional `passingThreshold` percentage for CI gates
- **Runner** is model-agnostic: accepts any LangChain-compatible model config alongside the suite; swapping models to compare performance is a first-class operation
- Results stored in SQLite with full provenance (model ID, suite name, timestamp, per-scenario scores) — same DB as conversation memory and tasks
- **API**: `POST /api/v1/evaluations/run` — accepts suite name + model config, returns run ID; `GET /api/v1/evaluations/:runId` for results; `GET /api/v1/evaluations` for history
- **UI surface**: Settings → Models → "Run Evaluation Suite" — pick a suite, optionally pick a second model to compare side-by-side; results shown as a scored table with pass/fail per scenario; eventually a dashboard widget tracking scores over time
- **Dev CLI**: `npm run eval -- --suite wiki-search --model ollama/llama3.2` prints a summary table and exits non-zero if the suite's `passingThreshold` is not met — CI-friendly
- First suite to define: `wiki-search` — written before Connect LLM-Wiki to Chat Agent (#8) as the TDD specification for that feature

---

### File Attachment in Chat Input

**Goal:** Wire up the "Add file" menu item in `ChatInput` so users can attach images or documents to a message.

**Ideas / Requirements:**

- Implement `onAddFile` in `ThreadView` — open a native file picker, read the selected file
- Images: convert to base64, display as a `ChatInputChip` in the header slot, and include in the message payload
- The API chat route should accept an optional `attachments` array alongside `content`
- Pass attachments to the LangGraph agent as multimodal content blocks (Ollama supports vision via `llava`-style models)
- Non-image files: extract text content server-side and prepend to the message as context
- Show a loading chip while the file is being read

**Dependencies:** Persistent Artifact Store

---

### Home / Conversation List Page

**Goal:** Build the Home page that lists all past conversations so users can switch between threads.

**Ideas / Requirements:**

- Lists all persisted threads (title derived from first message, timestamp, message count)
- Clicking a thread loads it into `ThreadView`
- "New conversation" button creates a fresh thread UUID
- Threads should be deletable
- Route: `/` for the list, `/thread/:id` for a specific thread (requires a client-side router)
- Consider `wouter` or `preact-iso` for lightweight routing

**Dependencies:** Multi-Conversation Support

---

### MCP Tool Configuration UI

**Goal:** Let users add, remove, and toggle MCP servers through the Settings page without editing `mcp.json` by hand.

**Ideas / Requirements:**

- List configured MCP servers with enabled/disabled toggle
- Form to add a new server: transport type (stdio / SSE), command or URL, environment variables
- Test connection button that pings the server and lists discovered tools
- Changes should POST to a new `PATCH /api/v1/settings/mcp` endpoint that writes `mcp.json` and triggers an agent rebuild
- Show currently active tools per server (collapsed by default)

**Dependencies:** Connect Tools Manager to Chat Agent, Settings Page UI

---

### Multi-Conversation Support

**Goal:** Support multiple independent chat threads within a single session and across page reloads.

**Ideas / Requirements:**

- Generate and persist thread IDs in `localStorage` (list of `{ id, title, createdAt, updatedAt }`)
- `threadId` is no longer a single `crypto.randomUUID()` at module load — it becomes the active thread from router state
- The API already supports arbitrary `threadId` values; no backend routing changes needed beyond persistence
- The sidebar should list recent threads (currently it has the nav structure but no thread list)
- Title generation: derive from the first user message (truncated) or ask the LLM to summarise

**Dependencies:** Persistent Conversation Memory

---

### Notification Delivery

**Goal:** Deliver agent escalations to the user through external channels (push, email, mobile) when they are not in the application. Deferred — each channel has implications for how the user can respond (quick actions, reply-by-email, deep links) that warrants its own design. The interim mechanism is an `action_required` flag on threads and tasks.

**Ideas / Requirements:**

- Interim solution: threads and tasks expose `action_required: boolean`; the Escalation System sets it; the UI surfaces flagged items prominently — no external channel needed at this stage
- The Escalation System routes through a `NotificationInterface`, not directly to channels — channels are pluggable without touching escalation logic
- First external channel: browser push via ServiceWorker — no server-side sending required, works when the user is in a browser but not on the current tab
- Subsequent channels: email (configurable SMTP), mobile (future; requires a companion app or PWA)
- Quick-action support (respond from the notification itself) is channel-specific: browser push supports action buttons; email supports mailto reply links; design each per-channel when implemented
- A user preference model is needed: which escalation tiers route to which channels, and during what hours

**Dependencies:** Escalation System

---

### Observability

**Goal:** A custom, in-application tracing implementation for agent checkpoints and tool calls — kept local rather than sent to LangSmith, surfaced directly in the UI, and used as the data source for evaluation results and cost tracking.

**Ideas / Requirements:**

- New package: `lib/observability` — defines trace and span schemas, a tracer interface, a LangChain `CallbackHandler`, and a SQLite-backed store
- **Trace**: `{ traceId, threadId?, taskId?, provider, model, startedAt, endedAt, totalTokens, totalCostEstimate }`
- **Span**: `{ spanId, traceId, parentSpanId?, type: 'llm-call' | 'tool-call' | 'checkpoint', name, startedAt, endedAt, inputTokens, outputTokens, latencyMs, input, output, error? }`
- A LangChain `CallbackHandler` plugs into the chat agent and Thread Type 2 — emits spans automatically on each LLM call and tool invocation without changes to agent logic
- SQLite storage alongside conversation memory and tasks
- API: `GET /api/v1/traces` (paginated list), `GET /api/v1/traces/:traceId` (full trace with all spans); query params: `?taskId=`, `?threadId=`, `?since=`
- UI surface: task and thread detail views show the full execution trace (collapsible spans, token counts, latency per step) — this is the Agent Execution Traces capability
- Evaluation runner reads trace data to enrich eval results with latency and token counts; eval scenarios can assert on trace shape (e.g. "this query must not trigger more than 2 LLM calls")

---

### Persistent Artifact Store

**Goal:** Provide a durable, shared storage layer for all artifacts in the system — files uploaded by the user in the chat interface and files generated by agents during task execution.

**Ideas / Requirements:**

- Replace the in-memory `Map<string, Artifact>` in `artifact-store.ts` with file-system persistence
- Store originals under `ARTIFACT_ROOT` (env var, default `./config/artifacts/<id>/original.<ext>`)
- Store processed WebP and preview JPEG alongside the original on write
- On startup, scan `ARTIFACT_ROOT` and hydrate the in-memory index (no re-processing needed)
- The `GET /artifacts/:id` routes are already correct; only the store implementation changes
- The store is the write target for File Attachment uploads (user → system) and the read/write target for agent-generated files (charts, reports, exported documents)
- Add a metadata file per artifact (`meta.json`) capturing: origin (`user-upload` vs `agent-generated`), MIME type, creating task ID or thread ID, and creation timestamp — this lets the dashboard and task system reference artifacts by ID without re-reading file content

---

### Persistent Conversation Memory

**Goal:** Survive API restarts without losing conversation history, and establish SQLite as the shared persistence layer for downstream systems.

**Ideas / Requirements:**

- Replace `MemorySaver` in `chat-agent.ts` with a file-system or SQLite checkpointer
- LangGraph ships `SqliteSaver` (`@langchain/langgraph-checkpoint-sqlite`) — lowest-friction option
- Store the SQLite DB at a configurable path (env var `CHECKPOINT_DB`, default `./config/checkpoints.db`)
- Ensure the `config/` directory is `.gitignore`d (it likely already is)
- No API or UI changes required — the `thread_id` config key already flows through correctly
- The same SQLite file (or a sibling file) will be used by the Task System

---

### Provider Registration

**Goal:** Allow the user to configure one or more LLM inference providers in a centralised config file, with support for OpenAI-compatible APIs and Anthropic. All agent code uses a provider factory rather than hardcoding a model class.

**Ideas / Requirements:**

- `config.yaml` at a configurable path holds all system configuration; a **Config Manager** (`lib/config`) reads, validates (Zod), and exports typed config at startup — replacing the current scattered env vars
- Provider section in `config.yaml`:
  ```yaml
  providers:
    - name: local
      type: ollama
      baseUrl: http://localhost:11434
      defaultModel: llama3.2
    - name: anthropic
      type: anthropic
      apiKey: ${ANTHROPIC_API_KEY}
      defaultModel: claude-sonnet-4-6
  defaultProvider: local
  ```
- Supported types: `ollama` (OpenAI-compatible), `openai`, `anthropic` — each backed by the corresponding LangChain class
- `createProvider(name?: string, model?: string): BaseChatModel` factory used by the chat agent, eval runner, and Thread Type 2 — replaces hardcoded `ChatOllama`
- Existing env vars (e.g. `OLLAMA_BASE_URL`) become override sources for config values; current setup must not break
- Config Manager validates on startup and emits clear errors for missing API keys or unreachable base URLs
- API: `GET /api/v1/providers` — lists configured providers with their available models (queried live where possible)
- UI: Settings → Providers section lists configured providers, current default, and allows selecting a model per conversation or task

---

### Settings Page UI

**Goal:** Build the Settings page behind the sidebar "Settings" nav link.

**Ideas / Requirements:**

- Route: `/settings` (requires adding a client-side router)
- Sections: General (theme already handled by `ThemeToggle`), Model (LLM model selector, base URL), MCP Servers, Skills
- Model settings should POST to a new `PATCH /api/v1/settings/model` endpoint that updates env/config and rebuilds the agent
- The page shell should be built first (empty sections) so MCP and Skills UI can be added incrementally

---

### Skills Integration

**Goal:** Expose the `skills-manager` library through the API and surface available skills in the UI.

**Ideas / Requirements:**

- Add a `GET /api/v1/skills` route listing enabled skills (name, description, trigger phrases)
- Add a `POST /api/v1/skills/:name/run` route to execute a skill script with arguments
- Register each enabled skill as a LangGraph tool via the tools manager so the agent can invoke skills autonomously
- In the UI, surface skills in the "Add to message" menu or as slash-command suggestions (the `ChatInput` already has a stub `data-slot="chat-input-slash-menu"` div)
- Settings page: list all skills with enabled/disabled toggle and description

**Dependencies:** Settings Page UI

---

### Task System

**Goal:** Provide a persistent model of every unit of autonomous work — its type, goal, authority level, current stage, and history — so that triggers, escalation, and dashboards all have a shared source of truth.

**Design origin:** [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md) — The Task System

**Ideas / Requirements:**

- A task record captures: id, type (chat/automated/triggered), goal/description, authority level, current stage, created/updated timestamps, escalation conditions, and output summary
- Stage state machine: `pending → running → waiting_on_user → done | failed | cancelled`; `running` can also transition to `blocked` (agent self-scheduled wakeup) and back to `running` when the trigger fires — blocked is a deliberate park, not an error
- Persisted in SQLite (same layer as conversation memory) — the task record survives API restarts
- WIP limits: configurable cap on how many tasks can be in `running` state simultaneously to prevent resource exhaustion
- The Kanban board in the UI is a view over this store — users can see all tasks, their stages, and act on them (cancel, reprioritize, provide input)
- Both Thread Type 2 (Automated Task) and trigger-initiated work create task records; conversational chat threads may optionally create lightweight task records for visibility
- Exposes: `GET /api/v1/tasks`, `GET /api/v1/tasks/:id`, `PATCH /api/v1/tasks/:id` (for user actions), `DELETE /api/v1/tasks/:id`

**Dependencies:** Persistent Conversation Memory

---

### Thread Type 2: Automated Task

**Goal:** Implement a second thread mode for goal-directed autonomous tasks where the agent reads and writes the wiki in a loop until a goal is met.

**Ideas / Requirements:**

- New API endpoint or thread-type flag: `POST /api/v1/task/:threadId` (or `?mode=task` on the existing route)
- Flow per the design doc:
  1. Call `wiki.orient()` to load SCHEMA + INDEX + recent log entries as planning context
  2. Agent plans its approach
  3. Loop: `wiki.semanticSearch()` → if no pages found, `wiki.ingestPrep()` + `wiki.commitPage()` a new stub; if pages found, decide short (`wiki.readPage()`) or long (`rlm.run()`)
  4. Accumulate findings; call `wiki.commitPage()` to update/supplement if new knowledge is extracted
  5. Check goal: if not met, iterate from step 3; if met, call `wiki.lint()` then return task complete
- All wiki reads and writes are visible in the stream as tool call events (no background-only writes unlike Thread Type 1)
- The UI needs a way to initiate a task vs. a conversation — consider a mode toggle in `ChatInput` or a separate entry point in the sidebar

**Dependencies:** Wiki Orient Tool (`wiki.orient()`), Wiki Write Tooling, Wiki Lint Tool (`wiki.lint()`), Web/URL Ingestion Tool, Connect RLM to Chat Agent, Task System

---

### Trigger System

**Goal:** Allow work to be initiated without human input via scheduled, interval, duration, and event-based triggers — the mechanism that makes the agent genuinely autonomous rather than purely reactive.

**Design origin:** [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md) — Non-Chat Triggers

**Ideas / Requirements:**

- Four trigger types:
  - **Interval**: recurring on a cron-style schedule (e.g. process inbox every morning at 7am)
  - **Scheduled**: one-shot at a specific datetime (e.g. send briefing at start of next quarter)
  - **Duration**: fires when a task has been in a given stage longer than a threshold (e.g. escalate if waiting_on_user for more than 4 hours)
  - **Event**: external signal via webhook or internal pub/sub (e.g. an alert fires, an email arrives)
- Each trigger resolves to a task in the Task System with a defined goal and authority level
- Trigger lifecycle: create, enable, disable, delete; recurring triggers persist across restarts
- Persisted in SQLite alongside tasks
- Exposes: `GET /api/v1/triggers`, `POST /api/v1/triggers`, `PATCH /api/v1/triggers/:id`, `DELETE /api/v1/triggers/:id`
- Webhook endpoint for event triggers: `POST /api/v1/triggers/webhook/:triggerId`
- The UI should allow the user to configure triggers (initially in Settings, eventually a dedicated view)

**Dependencies:** Task System

---

### Usage and Cost Tracking

**Goal:** Surface per-provider, per-model token usage and estimated cost so the user can understand their consumption and make informed model choices.

**Ideas / Requirements:**

- Built on Observability — aggregates token counts from the trace span store; no separate instrumentation needed
- Cost configuration in `config.yaml`:
  ```yaml
  costs:
    anthropic/claude-sonnet-4-6:
      inputPer1kTokens: 0.003
      outputPer1kTokens: 0.015
    openai/gpt-4.1-mini:
      inputPer1kTokens: 0.0004
      outputPer1kTokens: 0.0012
  ```
- Ollama / local providers can be configured with `0` cost or omitted — explicitly free
- A `CostCalculator` in `lib/observability` looks up the cost config and computes estimated cost at trace close time
- A pre-aggregated summary table in SQLite (updated per-trace): `{ date, provider, model, inputTokens, outputTokens, estimatedCost }` — avoids scanning all spans for cost queries
- API: `GET /api/v1/usage` — aggregated usage and cost by time period (day/week/month), provider, and model
- UI: Dashboard widget ("Estimated spend this week: $X.XX across N models") and Settings → Usage section with detailed breakdown
- Evaluation results include cost per run, enabling cost-vs-quality tradeoffs to be quantified explicitly

**Dependencies:** Provider Registration

---

### Web/URL Ingestion Tool

**Goal:** Let the agent fetch content from a URL and ingest it into the wiki when a knowledge gap is detected during an automated task.

**Ideas / Requirements:**

- Add a `web_fetch` built-in tool that accepts a URL, fetches the page, and returns cleaned text (strip scripts/styles, extract main content)
- A separate `wiki_ingest` tool wraps `wiki.ingestPrep({ content, url })` + `wiki.commitPage()` for the agent to call after fetching
- Or combine into a single `web_ingest` tool that fetches and commits in one step (simpler, less composable)
- Respect `robots.txt` and add a configurable request timeout
- Used exclusively in the automated task flow (Thread Type 2); the conversational flow writes are handled by AfterAgent Middleware instead

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Lint Tool (`wiki.lint()`)

**Goal:** Expose the wiki linter as an agent-callable tool so automated tasks can validate wiki health before completing.

**Ideas / Requirements:**

- Add a `wiki_lint` tool in `api/src/agents/tools/` that calls `llmWiki.lint()` and returns the structured result
- The linter runs 12 checks (already implemented in `@tkottke90/llm-wiki`); surface pass/fail counts and any failures to the agent
- The agent can use the output to decide whether to fix issues before declaring the task complete
- Also useful as a standalone maintenance tool the user can trigger from the Settings page

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Orient Tool (`wiki.orient()`)

**Goal:** Give the agent a single call to load the wiki's structural context (schema, index, recent log entries) before planning an automated task.

**Ideas / Requirements:**

- Add a `wiki_orient` tool in `api/src/agents/tools/` that returns the wiki's `SCHEMA.md`, `index.md`, and the last N entries from `log.md`
- Check whether `wiki.orient()` already exists on the `LlmWiki` class; if not, add it as a method that assembles the three documents
- The result is injected as context at the start of Thread Type 2 turns so the agent knows the knowledge graph shape before searching
- Keep the payload small: summarise the index if it exceeds a token budget rather than passing the full file

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Write Tooling

**Goal:** A unified set of wiki write and commit tools used by all agent patterns — Thread Type 1 via AfterAgent Middleware, Thread Type 2, and triggered tasks — so write logic is defined once and not reimplemented per pattern.

**Ideas / Requirements:**

- `wiki_update_page` tool: accepts an existing page path and updated content with a commit message; validates the path is within the wiki root; calls `llmWiki.commitPage()`
- `wiki_create_page` tool: for new pages — accepts a title, content, and target section; calls `llmWiki.ingestPrep()` then `llmWiki.commitPage()`
- Both tools emit a `wiki_updated` SSE event so the UI reflects the change regardless of which pattern triggered the write
- AfterAgent Middleware refactors to call these tools rather than calling the wiki SDK directly — one write path, not three
- Thread Type 2 uses these tools directly during its loop (step 4: commit updated knowledge) rather than a bespoke implementation
- Dry-run mode on both tools: returns a diff of what would be committed without writing — used in evaluation scenarios that assert on wiki output without side effects
- Both tools validate minimum content requirements (non-empty, passes basic schema check) before committing

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wire Up Domain Knowledge Bases

**Goal:** Define at least one domain and register it so `llm-wiki` has a wiki to operate against.

**Ideas / Requirements:**

- Create an initial domain directory under `WIKI_ROOT` (e.g. `general/`) with `SCHEMA.md`, `index.md`, `log.md`
- Add the domain to `api/src/knowledge-base/domains/index.ts` (currently exports an empty array)
- The `WikiRegistry` and `LlmWiki` classes in `@tkottke90/llm-wiki` handle everything else
- Consider shipping a seed script (`npm run seed:kb`) that scaffolds the directory structure on first run
- Decide on embedding provider: Ollama (local, free) vs. null adapter (keyword-only BM25 search, no setup required) — null is a safe default

---

### `wiki_updated` SSE Event

**Goal:** Add a new SSE event type to the shared protocol so the UI can show a notification when a background wiki commit completes.

**Ideas / Requirements:**

- Add `wiki_updated` to the `ChatSSEEventSchema` discriminated union in `lib/llm-common-types/src/chat/sse-events.ts`
- Payload: `{ type: 'wiki_updated', pageTitle: string, pageKind: string, wikiName: string }`
- The UI should render this as a subtle inline indicator in the message stream (e.g. a small "📖 Wiki updated: _Entity Name_" chip), not a full message bubble
- Emitted by AfterAgent Middleware after a successful `wiki.commitPage()` call
- Update `handleEvent` in `ui/src/hooks/use-thread.ts` and add a corresponding `ThreadMessage` kind (`wiki_update`) to render it
