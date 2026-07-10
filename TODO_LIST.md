# TODO List

## 1. Outstanding Items

Items are ordered first by priority/necessity, then by dependency.

1. [Connect Tools Manager to Chat Agent](#connect-tools-manager-to-chat-agent) — unlocks MCP tool support; no dependencies
2. [Wire Up Domain Knowledge Bases](#wire-up-domain-knowledge-bases) — prerequisite for all knowledge features
3. [Connect LLM-Wiki to Chat Agent](#connect-llm-wiki-to-chat-agent) — depends on: #2
4. [Connect RLM to Chat Agent](#connect-rlm-to-chat-agent) — depends on: #3
5. [Persistent Conversation Memory](#persistent-conversation-memory) — currently lost on API restart
6. [Persistent Artifact Store](#persistent-artifact-store) — currently lost on API restart
7. [Multi-Conversation Support](#multi-conversation-support) — depends on: #5
8. [File Attachment in Chat Input](#file-attachment-in-chat-input) — UI wiring already stubbed
9. [Skills Integration](#skills-integration) — `skills-manager` library is complete; needs API + UI
10. [Settings Page UI](#settings-page-ui) — sidebar nav link is currently a `#` stub
11. [MCP Tool Configuration UI](#mcp-tool-configuration-ui) — depends on: #1, #10
12. [Home / Conversation List Page](#home--conversation-list-page) — depends on: #7

---

## 2. Item Details

### Connect LLM-Wiki to Chat Agent

**Goal:** Expose the knowledge base as a tool the LangGraph ReAct agent can read from and write to during conversations.

**Ideas / Requirements:**
- Add `wiki_search` and `wiki_upsert` tools in `api/src/agents/tools/` using `@tkottke90/llm-wiki`
- `wiki_search` should perform hybrid BM25 + embedding search against the active wiki(s) and return ranked results
- `wiki_upsert` should let the agent add or update a knowledge page (entity, concept, comparison, etc.)
- The wiki root should be configured via the existing `WIKI_ROOT` env var
- Consider whether the agent should have read-only access by default with write access opt-in
- Tools should handle errors gracefully (wiki not initialised, embedding provider unavailable, etc.)

**Dependencies:** Wire Up Domain Knowledge Bases

---

### Connect RLM to Chat Agent

**Goal:** Let the agent use the Retrieval Loop Model engine to answer questions over large corpora that exceed the model's context window.

**Ideas / Requirements:**
- Add an `rlm_query` tool in `api/src/agents/tools/` that accepts a natural-language question and a target wiki/domain
- The tool should instantiate `RLM` with the `OllamaInferenceAdapter` and the configured `WIKI_ROOT`
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

### File Attachment in Chat Input

**Goal:** Wire up the "Add file" menu item in `ChatInput` so users can attach images or documents to a message.

**Ideas / Requirements:**
- Implement `onAddFile` in `ThreadView` — open a native file picker, read the selected file
- Images: convert to base64, display as a `ChatInputChip` in the header slot, and include in the message payload
- The API chat route should accept an optional `attachments` array alongside `content`
- Pass attachments to the LangGraph agent as multimodal content blocks (Ollama supports vision via `llava`-style models)
- Non-image files: extract text content server-side and prepend to the message as context
- Show a loading chip while the file is being read

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

### Persistent Artifact Store

**Goal:** Survive API restarts without losing uploaded or agent-generated images.

**Ideas / Requirements:**
- Replace the in-memory `Map<string, Artifact>` in `artifact-store.ts` with file-system persistence
- Store originals under `ARTIFACT_ROOT` (env var, default `./config/artifacts/<id>/original.<ext>`)
- Store processed WebP and preview JPEG alongside the original on write
- On startup, scan `ARTIFACT_ROOT` and hydrate the in-memory index (no re-processing needed)
- The `GET /artifacts/:id` routes are already correct; only the store implementation changes

---

### Persistent Conversation Memory

**Goal:** Survive API restarts without losing conversation history.

**Ideas / Requirements:**
- Replace `MemorySaver` in `chat-agent.ts` with a file-system or SQLite checkpointer
- LangGraph ships `SqliteSaver` (`@langchain/langgraph-checkpoint-sqlite`) — lowest-friction option
- Store the SQLite DB at a configurable path (env var `CHECKPOINT_DB`, default `./config/checkpoints.db`)
- Ensure the `config/` directory is `.gitignore`d (it likely already is)
- No API or UI changes required — the `thread_id` config key already flows through correctly

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

---

### Wire Up Domain Knowledge Bases

**Goal:** Define at least one domain and register it so `llm-wiki` has a wiki to operate against.

**Ideas / Requirements:**
- Create an initial domain directory under `WIKI_ROOT` (e.g. `general/`) with `SCHEMA.md`, `index.md`, `log.md`
- Add the domain to `api/src/knowledge-base/domains/index.ts` (currently exports an empty array)
- The `WikiRegistry` and `LlmWiki` classes in `@tkottke90/llm-wiki` handle everything else
- Consider shipping a seed script (`npm run seed:kb`) that scaffolds the directory structure on first run
- Decide on embedding provider: Ollama (local, free) vs. null adapter (keyword-only BM25 search, no setup required) — null is a safe default

**Dependencies:** none
