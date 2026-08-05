# TODO List

## 1. Completed Items

1. [Connect Tools Manager to Chat Agent](#connect-tools-manager-to-chat-agent) — unlocks MCP tool support; no dependencies
2. [Automated E2E Tests](#automated-e2e-tests) — Playwright test suite covering key user flows; LLM-dependent tests tagged and skipped in CI
3. [File-based Configuration](#file-based-configuration) — `config.yaml` as primary config source; `${ENV_VAR}` interpolation; auto-created on first run; `POST /api/v1/settings/reload` endpoint
4. [Provider Registration](#provider-registration) — `providers[]` config block; `createProvider()` factory for Ollama/OpenAI/Anthropic; `GET /api/v1/providers` endpoint; legacy `llmBaseUrl`/`llmModel` fields removed
5. [Observability](#observability) — `lib/observability` library with SQLite-backed trace/span store; LangChain callback handler; `/v1/traces` REST endpoints; shared `openDatabase()` connection factory
6. [Wire Up Domain Knowledge Bases](#wire-up-domain-knowledge-bases) — disk-driven `WikiRegistry`; auto-initialises "user" and "self" domains on first boot (checked individually so an existing install missing one still picks it up); `bootKnowledgeBase()` wired into startup sequence
7. [Usage and Cost Tracking](#usage-and-cost-tracking) — `CostStore` in `lib/observability`; pricing config in `config.yaml`; `seedProviderCosts()` syncs on startup; `GET /api/v1/usage` endpoint
8. [Evaluation Harness](#evaluation-harness) — `lib/evaluations` package; deterministic/semantic/LLM-as-judge eval methods; SQLite result store; `POST /api/v1/evaluations/run` endpoint; `npm run eval` CLI
9. [`wiki_updated` SSE Event](#wiki_updated-sse-event) — `WikiUpdatedSchema` added to `ChatSSEEvent`; `wiki_update` `ThreadMessage` kind; `WikiUpdateMessage` chip component in UI
10. [Connect LLM-Wiki to Chat Agent](#connect-llm-wiki-to-chat-agent) — `wiki_search` (hybrid BM25 + embedding, all domains) and `wiki_read_page` tools added to the ReAct agent; graceful degradation when wiki unavailable
11. [AfterAgent Middleware](#afteragent-middleware) — heuristic post-hoc LLM pipeline (summarize → classify → extract → merge) fires as a `createAgent` `afterAgent` middleware hook; writes go through `ingestPrep`/`commitPage` with raw-source provenance; `wiki_updated` SSE events queue per-thread and flush at the start of the next turn
12. [Persistent Conversation Memory](#persistent-conversation-memory) — `SqliteSaver` checkpointer for LangGraph execution state; new `ThreadStore` read-projection (`threads`/`thread_messages`) for UI display, decoupled from checkpoint internals; thread CRUD + fork + retry + `generate-title` endpoints; sidebar for browsing/switching/renaming/deleting/forking threads; visible, retryable turn failures with a `showErrorMessages` history toggle
13. [Persistent Artifact Store](#persistent-artifact-store) — disk-backed storage under `artifactRoot` (`config.yaml`); per-artifact `meta.json` captures origin/thread/task provenance; index hydrated from disk on boot so artifacts survive restarts; `tool-call` eval scenario type added to the evaluation harness to regression-test tool-invocation behavior, starting with `upload_image`
14. [Wiki Locate & Orient Tools](#wiki-locate--orient-tools) — `wiki_locate` (domain-level lookup via the registry's deterministic routing scorer, plus a browse mode) and `wiki_orient` (full structural state of one domain via the already-existing `LlmWiki.orient()`) added to the ReAct agent; `wiki_search`'s description clarified to disambiguate the three; `wiki-navigation` eval suite added to regression-test locate → orient → search/read coordination; a code-level `buildSystemPrompt()` template (harness wiki-navigation guidance + an unwired user-instructions slot) wired into the chat agent; `bin/eval.ts` fixed to register `wiki_locate`/`wiki_orient` (previously missing — every prior `wiki-navigation` scenario expecting them was silently unrunnable) and to pass the real system prompt into eval runs; eval harness gained optional `systemPrompt` support for `tool-call`/`tool-sequence` scenarios
15. [Agent Behavior Baseline (System Prompt)](#agent-behavior-baseline-system-prompt) — `HARNESS_SECTIONS` in `system-prompt.ts` extended with `IDENTITY_SECTION` (no built-in memory of the user — the wiki is the source of truth), `MEMORY_SECTION` (cold-start turns must check the wiki before answering from assumption), and `ASK_USER_SECTION` (structured clarification must go through `ask_user`, not plain-text questions); `config/AGENT.md` (auto-created, supplement-only precedence over harness sections) wired in as the user-instructions injection point via `agent-instructions.ts`; new `instruction-hierarchy`, `thread-titles`, and `tool-calling` eval suites added; wording iterated against real `ornith`/`glm` eval runs (documented inline in `system-prompt.ts`) without regressing `wiki-navigation.yaml`
16. [Wiki Write Tooling](#wiki-write-tooling) — shared, non-LLM write functions `createWikiPage`/`updateWikiPage` in `api/src/services/wiki-write.ts`; thin `wiki_create_page`/`wiki_update_page` LangChain tool wrappers wired into the live chat agent (Thread Type 1 now has direct wiki write access, independent of AfterAgent's background pass) and the eval harness; AfterAgent Middleware refactored to call the same shared functions instead of the SDK directly — one write path instead of two; dry-run mode returns a diff without committing; `wiki_create_page` refuses (pointing to `wiki_update_page`) rather than silently overwriting a likely-duplicate page; `wiki_update_page` adds path-escape validation the SDK itself doesn't have; new `wiki-write` eval suite added, plus two previously-deferred `wiki-navigation` scenarios revived
17. [Wiki Lint Tool](#wiki-lint-tool-wikilint) — `wiki_lint` tool (`api/src/agents/tools/wiki-lint.tool.ts`) wrapping `WikiRegistry.lint(id)`; read-only diagnostic scoped to one domain per call: reports broken links, orphaned pages, missing frontmatter, stale content, tag/index drift, and 8 other checks, formatted as a grouped severity report (errors/warnings/info); deliberately read-only this round (agent can fix `broken_links`/`index`/`stale` via `wiki_read_page`+`wiki_update_page` today; full remediation gap tracked in Wiki Lint Remediation Tools); AfterAgent Middleware gains a logging-only post-write lint check (own try/catch — never flips the write's `identified` outcome); new `wiki-lint` eval suite with `wlint-001` (domain-established, `tool-sequence`) and `wlint-002` (locate-before-lint, `tool-call`) scenarios
18. [Wiki Lint Remediation Tools](#wiki-lint-remediation-tools) — closed the gap between what `wiki_lint` reports and what the agent can fix: `wiki_update_page` extended with `tags`, `confidence`, `contested`, and `contradictions` params; `wiki_create_page` extended with `confidence`, `contested`, `contradictions`; `wiki_add_cross_link` tool added (wraps `LlmWiki.addCrossLink()`) for `orphans`; `wiki_rebaseline_source` tool added (wraps new `LlmWiki.rebaselineRawSource()`) for `source_drift`; `wiki_register_domain` tool added (wraps new `WikiRegistry.register()`) for `registry_sync` — went beyond original spec to cover all 12 finding types; carry-forward semantics on epistemological fields; four new `wiki-lint` eval scenarios (`wlint-003` through `wlint-006`); `wiki_lint` tool description updated to reflect full fix coverage
19. [LLM Wiki UI & Direct Authoring Tools](#llm-wiki-ui--direct-authoring-tools) — `/wiki` route with D3 force-graph view (node radius by edge count, domain fill color, dashed border for contested pages, hover card) and document view (domain selector, page list grouped by type, Edit/Preview toggle, wikilink resolution); dedicated wiki ingestion agent (`wiki-ingestion-agent.ts`) with its own system prompt and persistent thread, separate from the general chat agent; `IngestionChat` UI panel with `NewDomainModal` and `NewPageForm` that compose structured messages to the ingestion agent; archive upload dialog (`.tar.gz`/`.zip`) for importing llm-wiki-formatted domains with lint gating and rollback; all four read endpoints (`/api/v1/wiki/domains`, `/graph`, `/pages`, `/pages/*`); `wiki_domain_created` SSE event; one remaining gap not yet implemented: file upload affordance in the ingestion chat input (URL ingestion via `web_fetch` has since landed with the Web/URL Ingestion Tool)
20. [Web/URL Ingestion Tool](#weburl-ingestion-tool) — `web_fetch` tool (`api/src/agents/tools/web-fetch.tool.ts`) over a non-LLM `fetchUrl()` service (`api/src/services/web-fetch.ts`): reader-mode extraction for HTML via linkedom + Readability (article body, title/description, up to 50 outbound links, H1–H3 heading outline), pretty-printed JSON for JSON endpoints; per-origin `robots.txt` preflight with a process-lifetime cache, configurable via a new `webFetch` config block (`respectRobotsTxt`, `timeoutMs`); wired into the chat agent, the wiki ingestion agent (closing that item's URL-ingestion gap), and the eval harness; no separate `wiki_ingest` wrapper — the agent composes `web_fetch` with the existing wiki write tools; new `WEB_FETCH_SECTION` system-prompt guidance (fetch → route → write ordering); new `web-fetch` eval suite (5 scenarios), converged 5/5 on ornith, glm, and qwen3.5:4b
21. [Connect RLM to Chat Agent](#connect-rlm-to-chat-agent) — `rlm_query` tool added to the ReAct agent; accepts a natural-language question and a page path and passes the page content through the RLM engine for long-context retrieval; `StatusSignal` callbacks streamed to the SSE layer for per-iteration UI progress; `RLM_MAX_ITERATIONS` env var (default 10) caps iteration depth

---

## 2. Outstanding Items

Items are ordered first by priority/necessity, then by dependency.

1. [Agent Skills (Slash Commands)](#agent-skills-slash-commands) — skills per the [AgentSkills specification](https://agentskills.io/specification), invocable by user and agent via slash commands; no dependencies
2. [Shell Command Execution](#shell-command-execution) — depends on: #1; follow-up skill: shell environment, command policy, approval flow (reusing `ask_user` patterns), result captured as a tool call. **Note:** must coordinate with `SkillsManager` script execution — skills can carry JS and Python scripts (`runScript`, `runPythonScript`) that may invoke shell commands; the shell execution policy, approval flow, and audit trail established here should apply uniformly to both agent-initiated shell calls and skill-script-initiated shell calls.

---
**MVP line** — items above this point deliver a harness that can be driven by chat, learn via the wiki, and interact via shell and web fetch; items below are autonomous operation infrastructure.

3. [Task System](#task-system) — depends on: [Persistent Conversation Memory](#persistent-conversation-memory); foundational for all autonomous operation; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
4. [Thread Type 2: Automated Task](#thread-type-2-automated-task) — depends on: #3 ([Wiki Locate & Orient Tools](#wiki-locate--orient-tools), [Wiki Write Tooling](#wiki-write-tooling), [Wiki Lint Tool](#wiki-lint-tool-wikilint), [Wiki Lint Remediation Tools](#wiki-lint-remediation-tools), [Web/URL Ingestion Tool](#weburl-ingestion-tool), and [Connect RLM to Chat Agent](#connect-rlm-to-chat-agent) now complete — no longer blocking)
5. [Trigger System](#trigger-system) — depends on: #3; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
6. [Escalation System](#escalation-system) — depends on: #3; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
7. [Dashboard System](#dashboard-system) — depends on: #3, #6; see [Autonomous Collaboration Architecture](docs/Design/2026-07-10-autonomous-collaboration-architecture.md)
8. [Multi-Conversation Support](#multi-conversation-support) — depends on: [Persistent Conversation Memory](#persistent-conversation-memory)
9. [File Attachment in Chat Input](#file-attachment-in-chat-input) — depends on: [Persistent Artifact Store](#persistent-artifact-store) (now complete — no longer blocked); UI wiring already stubbed
10. [Settings Page UI](#settings-page-ui) — sidebar nav link is currently a `#` stub
11. [Skills Integration](#skills-integration) — depends on: #10 (Settings Page UI); `skills-manager` library is complete and wired as of Agent Skills; needs a Settings UI for managing skills: browse installed skills, enable/disable, view `SKILL.md` content, and install new skills by name or from a directory.
12. [MCP Tool Configuration UI](#mcp-tool-configuration-ui) — depends on: #10
13. [Home / Conversation List Page](#home--conversation-list-page) — depends on: #8
14. [Notification Delivery](#notification-delivery) — depends on: #6; external channels deferred; interim: `action_required` flag on threads/tasks

---

## 3. Item Details

### Agent Behavior Baseline (System Prompt)

**Goal:** Broaden the chat agent's system prompt beyond wiki tool-navigation guidance into a general behavior baseline — tone, identity, how to handle uncertainty, formatting conventions — informed by real usage rather than guessed upfront.

**Ideas / Requirements:**

- Extend `HARNESS_SECTIONS` in `api/src/agents/system-prompt.ts` (currently scoped to wiki tool-navigation and ask_user routing — see the "Wiki Locate & Orient Tools" completed entry) rather than introducing a second, competing prompt mechanism
- Content should come from observed gaps in real conversations, not a one-shot guess — this is explicitly expected to lean on the evaluation harness heavily: write `llm-judge`/`semantic` scenarios first to pin down what "good" looks like, then iterate the prompt against them
- User-instructions injection is `config/AGENT.md` (auto-created, supplement-only precedence over harness sections) — see the 2026-07-21 Agent Behavior Baseline system-prompt-pattern design doc; superseded the originally-considered `config.yaml` field
- Once an `IDENTITY_SECTION` exists, a future iteration is expected to make it the injection point for user-defined personality preferences — similar to the Hermes Agent `SOUL.md` pattern, where persona is a dedicated, directly-authored part of the agent's identity rather than an addendum appended after the fact. Revisit how `config/AGENT.md`'s current supplement-only append relates to this once `IDENTITY_SECTION` exists
- Should not regress the wiki tool-navigation guidance already proven out — new eval scenarios here should run alongside, not replace, `wiki-navigation.yaml`

**Dependencies:** none (builds on the already-shipped `system-prompt.ts` template)

---

### Agent Skills (Slash Commands)

**Goal:** Add skills to the platform based on the [AgentSkills specification](https://agentskills.io/specification), so that reusable instruction sets can be invoked via slash commands instead of every instruction being typed in by hand. Skills are usable by both the user and the agent.

**Ideas / Requirements:**

- Skills follow the AgentSkills spec: a skill is a directory containing a `SKILL.md` (frontmatter with name/description, body with the instructions) plus optional supporting files
- **Slash command detection:** any message starting with a slash followed by a command name (e.g. `/summarize`) is treated as a slash command — detection happens on the message, so it works for user-typed input and agent-composed messages alike
- **Expansion:** when a slash command matches a skill, the command is replaced with the contents of that skill's `SKILL.md` file before the message reaches the model — the skill body _is_ the instruction payload
- Arguments after the command name should be preserved and passed through to the expanded skill content
- Unmatched slash commands need a defined behavior (pass through as-is vs. error back to the user)
- The `ChatInput` slash-menu stub (`data-slot="chat-input-slash-menu"`) is the natural UI surface for skill suggestions/autocomplete
- Relationship to the existing [Skills Integration](#skills-integration) item (the `skills-manager` library, API routes, and Settings UI) needs to be reconciled during design — this item owns the AgentSkills-spec format and the slash-command invocation path; Skills Integration owns API/UI surfacing. They may merge.
- First follow-up skill planned: [Shell Command Execution](#shell-command-execution)

**Dependencies:** none

---

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
- **Interim delivery mechanism:** until [Notification Delivery](#notification-delivery) (#15) is built, the Escalation System sets `action_required: true` on the relevant thread or task record; the UI surfaces flagged items prominently (badge, pinned to top of conversation list) — covers the critical user-facing need without requiring an external channel

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

### LLM Wiki UI & Direct Authoring Tools

**Goal:** Surface the LLM Wiki in the UI as something the user can browse and directly author, not only something the agent reads and writes behind the scenes — including tools to import existing notes and kick-start a domain with real content instead of starting from an empty wiki.

**Ideas / Requirements:**

- A UI view for browsing wiki domains, their index, and individual pages
- Let the user create, edit, and organize domains/pages directly, without going through the chat agent
- Import tooling to bootstrap a domain from an existing note collection (e.g. an Obsidian vault export) — identify candidate domains from the source material and seed them with converted content, rather than starting from one or two empty wikis. Motivated by hands-on experience doing this manually (GH Copilot + a prior Obsidian vault) to kick-start a fresh wiki setup
- Intended to land before the Task System and the rest of the automation work (Task System, Thread Type 2, Trigger System, Escalation System, Dashboard System) — a wiki the user has already populated and organized should make that later automation meaningfully more useful from day one, rather than bootstrapping cold

**Dependencies:** Connect LLM-Wiki to Chat Agent (wiki must already be wired up)

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

### Shell Command Execution

**Goal:** Give the agent a shell environment for running commands — the first follow-up skill after [Agent Skills (Slash Commands)](#agent-skills-slash-commands) lands. Commands run in a controlled environment, gated by a policy and an approval flow, with results captured as tool calls.

**Ideas / Requirements:**

- **Environment setup:** define where commands execute — working directory, environment variables, and what isolation (if any) wraps the process; the environment should be configurable via `config.yaml`
- **Command policy:** control which commands are allowed to run — an allowlist (and/or denylist) so safe commands execute directly while everything else requires approval
- **Approval system:** commands outside the allowed set are routed to the user for approval before execution, probably reusing parts of the existing `ask_user` HITL flow (structured prompt, blocking wait, SSE round-trip) rather than building a second approval mechanism
- **Result capture:** the execution result (stdout, stderr, exit code) is captured and returned as a tool call, so it renders in the thread like any other tool invocation and lands in the observability trace store
- Approval decisions should be auditable — log what was requested, what was approved/denied, and what actually ran

**Dependencies:** Agent Skills (Slash Commands)

---

### Skills Integration

**Goal:** Surface the `skills-manager` library in a Settings UI so users can browse, enable/disable, inspect, and install skills without editing the filesystem directly.

**Ideas / Requirements:**

- Settings page section: list all installed skills (name, slash command, description, enabled toggle)
- Skill detail view: render the `SKILL.md` body so users can inspect what a skill does before invoking it
- Enable/disable toggle: writes `metadata.enabled` via `SkillsManager.edit()`; takes effect immediately
- Install by directory: point the UI at a local directory path; `SkillsManager.create()` scaffolds and adds it
- The `GET /api/v1/skills`, `search_skills` tool, and slash-menu autocomplete are already delivered by Agent Skills

**Dependencies:** Settings Page UI (#10)

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

**Delivered** (PR #44):

- `web_fetch` built-in tool (`api/src/agents/tools/web-fetch.tool.ts`) over a plain, non-LLM `fetchUrl()` service (`api/src/services/web-fetch.ts`): HTML pages come back as reader-mode article text (linkedom + `@mozilla/readability`) plus title/description metadata, up to 50 outbound links, and an H1–H3 heading outline; JSON endpoints come back pretty-printed
- Neither of the speculated write wrappers (`wiki_ingest` / combined `web_ingest`) was built — the agent composes `web_fetch` with the existing `wiki_create_page`/`wiki_update_page` tools instead, keeping one wiki write path per Wiki Write Tooling; the `web-fetch` eval suite regression-tests the fetch → locate → write composition end-to-end
- `robots.txt` respected by default via a per-origin preflight with a process-lifetime cache; new `webFetch` config block (`respectRobotsTxt`, `timeoutMs`) documented in `api/config.yaml.example`
- Wired into the conversational chat agent and the wiki ingestion agent now (Thread Type 2 doesn't exist yet), closing the URL-ingestion gap noted in LLM Wiki UI & Direct Authoring Tools — not exclusive to the automated task flow as originally sketched
- New `WEB_FETCH_SECTION` in the system prompt (fetch → route → write ordering; "save what you fetched" is an already-made decision, not a new question to ask) added after eval round 1; `web-fetch` suite (5 scenarios) converged 5/5 on ornith, glm, and qwen3.5:4b in 2 rounds

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Lint Remediation Tools

**Goal:** Close the gap between what `wiki_lint` (see below) can report and what the agent can actually fix with the existing write tools, so lint findings become actionable rather than purely diagnostic.

**Delivered** (PR #39 — went beyond original spec to cover all 12 finding types):

- `wiki_update_page` extended with `tags`, `confidence`, `contested`, and `contradictions` parameters; carry-forward semantics prevent agents from silently clearing prior epistemological assessments during routine updates
- `wiki_create_page` extended with `confidence`, `contested`, and `contradictions` parameters
- `wiki_add_cross_link` tool added (wraps `LlmWiki.addCrossLink()`) — fixes `orphans` findings without a full-body rewrite
- `wiki_rebaseline_source` tool added (wraps new `LlmWiki.rebaselineRawSource()`) — fixes `source_drift` findings; preserves original `source_url` while accepting current content as new ground truth
- `wiki_register_domain` tool added (wraps new `WikiRegistry.register()`) — fixes `registry_sync` findings; auto-extracts domain from SCHEMA.md with optional override
- `WikiRegistry.create()` refactored to delegate to the new `register()` method, eliminating duplication in the SDK
- Four new eval scenarios: `wlint-003` (rebaseline source), `wlint-004` (register domain), `wlint-005` (add cross-link, tool-sequence), `wlint-006` (update with confidence)
- `wiki_lint` tool description updated to reflect full fix coverage across all 12 finding types

**Dependencies:** Wiki Lint Tool

---

### Wiki Lint Tool (`wiki.lint()`)

**Goal:** Expose the wiki linter as an agent-callable tool so automated tasks can validate wiki health before completing.

**Delivered** — see [design doc](docs/superpowers/specs/2026-07-27-wiki-lint-tool-design.md): `wiki_lint` (`api/src/agents/tools/wiki-lint.tool.ts`) wraps `WikiRegistry.lint(id)` — one domain per call, formatted as a grouped severity report (errors/warnings/info with a status line). Scoped as a pure diagnostic this round: cross-checking all 12 checks against the existing write tools showed only `broken_links`/`index`/`stale` are fixable with `wiki_read_page`/`wiki_update_page` today; the tool description tells the agent to say so rather than claim a fix it can't make. AfterAgent Middleware gains a logging-only post-write lint check (own try/catch, never flips the write's `identified` outcome). New `wiki-lint` eval suite added (`wlint-001` domain-established, `wlint-002` locate-before-lint). Full remediation gap tracked as Wiki Lint Remediation Tools.

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Locate & Orient Tools

**Goal:** Give the agent a way to pick which wiki domain applies to a topic, and a way to load one domain's structural context (schema, index, recent log entries) before searching or writing in it.

**Delivered as two tools** (design surfaced that the original single-item description conflated two distinct jobs — see [spec](docs/superpowers/specs/2026-07-20-wiki-locate-and-orient-tools-design.md)):

- `wiki_locate` (`api/src/agents/tools/wiki-locate.tool.ts`) — domain-level lookup using the registry's existing deterministic id/domain/tag/routing-note scorer (`WikiRegistry.resolve()`); a no-argument browse mode lists all domains + routing notes via `.list()`/`.routingNotes()`. Read-only; never creates a domain on no-match.
- `wiki_orient` (`api/src/agents/tools/wiki-orient.tool.ts`) — full structural state of one named domain via the already-existing, already-tested `LlmWiki.orient()`; index truncated by whole lines past 4000 characters, not mid-entry.
- `wiki_search`'s tool description was lightly edited (no behavior change) to disambiguate it from the other two — it searches page content across all domains, distinct from `wiki_locate`'s domain-level lookup and `wiki_orient`'s full-catalog read.
- `suites/wiki-navigation.yaml` eval suite added, regression-testing locate → orient → search/read/ask_user coordination via the harness's `tool-call`/`tool-sequence`/`llm-judge` scenario types.
- Automatic orientation-context injection at the start of a Thread Type 2 turn is deferred to Thread Type 2 itself, since that thread type doesn't exist yet.

**Dependencies:** Connect LLM-Wiki to Chat Agent

---

### Wiki Write Tooling

**Goal:** A unified set of wiki write and commit tools used by all agent patterns — Thread Type 1 via AfterAgent Middleware, Thread Type 2, and triggered tasks — so write logic is defined once and not reimplemented per pattern.

**Delivered** (see [design doc](docs/superpowers/specs/2026-07-26-wiki-write-tooling-design.md)): the live chat agent now has direct wiki write access via `wiki_create_page`/`wiki_update_page`, independent of and in addition to AfterAgent's existing background write pass — both are separate write paths that can act on the same turn, with no explicit-vs-implicit guardrail between them.

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
