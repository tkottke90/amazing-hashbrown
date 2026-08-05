# Agent Skills (Slash Commands) — Design

**Date:** 2026-08-04
**Status:** Approved (design)
**Related:** [`TODO_LIST.md`](../../../TODO_LIST.md) items "Agent Skills (Slash Commands)" (#1) and "Skills Integration" (#11, narrowed), [`docs/ADR.md`](../../ADR.md) ADR-002

## Purpose

Wire the existing `@tkottke90/skills-manager` library into the chat agent so that:

1. Users can invoke reusable instruction sets by typing `/skill-name args` in the chat input.
2. The agent can discover available skills on demand via a `search_skills` tool.
3. Skill content is injected at LLM call time (not stored in the checkpoint), preserving clean conversation history.
4. A slash-command autocomplete menu in the UI surfaces available skills as the user types.

This spec merges the two overlapping TODO items: "Agent Skills (Slash Commands)" (#1) owns the invocation pipeline; "Skills Integration" (#11) is narrowed to a future Settings UI for managing skills (CRUD, enable/disable) and no longer includes LangGraph tool registration or `POST /api/v1/skills/:name/run`.

Skills are **not** registered as LangGraph tools. They are instruction payloads injected into the message pipeline, not callable functions.

---

## Background

### The AgentSkills standard

The feature aligns with the AgentSkills specification (agentskills.io), an open standard released by Anthropic in December 2025 and now governed by the Agentic AI Foundation. A skill is a directory containing a `SKILL.md` file with YAML frontmatter (`name`, `description` required) and a Markdown instruction body. The format is already used in this repo (`.claude/skills/`, `.agents/skills/`).

The `@tkottke90/skills-manager` library is a complete implementation of the AgentSkills format: it scans a root directory, builds an in-memory index, and exposes CRUD, search, and script execution. One library change is required: a `search()` method is added to `SkillsManager` in `lib/skills-manager`. The rest of this spec is wiring the library into the app.

### Injection timing — ADR-002

The spec's key architectural decision is documented in ADR-002: skill body expansion happens at **LLM call time** via LangGraph's `messageModifier`, not at chat time in `stream-handler.ts`. The checkpoint stores the original slash command (`/summarize my notes`); the modifier replaces it with the expanded skill body immediately before each LLM call. The modifier only expands the **most recent human message** — historical slash commands in the thread are never re-expanded.

See ADR-002 in `docs/ADR.md` for the full option comparison, AgentSkills spec research, and rationale.

---

## Scope

**In scope (this spec):**

- `search()` method added to `SkillsManager` in `lib/skills-manager`
- `skillsRoot` config key and first-boot directory creation
- `SkillsManager` singleton wired into app startup
- `messageModifier` in `buildChatAgent()` — slash command expansion and error handling
- `search_skills` LangGraph tool
- `GET /api/v1/skills?q=` REST endpoint
- Slash-command autocomplete in `ChatInput`
- `TODO_LIST.md` update: #11 narrowed

**Out of scope (deferred to #11 Skills Integration):**

- Settings UI: install, edit, enable/disable skills
- `allowed-tools` frontmatter enforcement (already deferred; tools-manager is now built, but wiring this is a separate task)
- `@name` mention-style invocation
- Autonomous agent skill selection without an explicit slash command

---

## Architecture

```
User types "/summarize my notes"
        │
        ▼
  ChatInput (UI)
  slash-menu fires on "/", shows matching skills via GET /api/v1/skills?q=
        │
        ▼  POST /api/v1/chat/:threadId  { content: "/summarize my notes" }
        │
  chat.route.ts → streamChatToSse()
  (content passes through unchanged)
        │
        ▼
  LangGraph checkpoint
  stores: "/summarize my notes"   ← original intent preserved
        │
        ▼  messageModifier (fires before each LLM call)
  detects "/" in latest human message
  expands via SkillsManager.lookup()
  returns: "[skill body]\n\nmy notes"
        │
        ▼
  LLM / ReAct agent
  (search_skills tool available for on-demand skill discovery)
```

---

## Component Design

### 1. `lib/skills-manager` — new `search()` method

Add a `search(keyword?: string): SkillSummary[]` method to `SkillsManager`:

- No keyword → returns all **enabled** skills from the in-memory cache
- With keyword → returns enabled skills where `name`, `description`, or `slashCommand` contains the keyword (case-insensitive substring match)

Both the `search_skills` tool and the REST endpoint delegate to this method. No duplicate filter logic elsewhere.

`SkillsManager.list()` continues to exist unchanged (returns all skills including disabled, used internally). `search()` is the public interface for consumer-facing lookups.

### 2. Config — `skillsRoot`

Add `skillsRoot` to `AppConfigSchema` in `api/src/config/env.ts`:

```yaml
# config.yaml
skillsRoot: ./skills   # default; resolved relative to config dir → config/skills
```

Document in `config.yaml.example` alongside `wikiRoot` and `artifactRoot`. The `config/skills/` directory is gitignored (all user customisations live in `config/`). App startup creates the directory if it does not exist.

### 3. `SkillsManager` singleton

New file: `api/src/services/skills-manager.ts`, following the `tools-manager.ts` pattern:

```ts
export const skillsManager = new SkillsManager(env.skillsRoot);
```

`skillsManager.boot()` is called during app startup after directory creation. The singleton is imported by the `messageModifier`, the `search_skills` tool, and the REST route.

### 4. Pre-LLM message transform in `buildChatAgent()`

Added to the `createAgent` call in `api/src/agents/chat-agent.ts`. The transform closes over `skillsManager`. The exact hook name (`beforeAgent`, `messageModifier`, or equivalent) must be verified against the `langchain` v1.5.2 API during implementation; if no such hook exists on `createAgent`/`createMiddleware`, the fallback is a thin model-wrapper that intercepts `invoke`/`stream` calls before they reach the underlying LLM. The behaviour contract is the same regardless of mechanism.

**Algorithm — runs before every LLM call:**

1. Find the last `HumanMessage` in the messages array.
2. If its content does **not** start with `/`, return messages unchanged (no-op).
3. Extract `commandName` (first word after `/`, stripped of leading `/`) and `args` (everything after the first space, may be empty).
4. Call `skillsManager.lookup(commandName)` (returns the skill body string).
   - **Found:** replace the last human message content with `${skillBody}\n\n${args}` (args appended on a new line; if args is empty, trailing newline is omitted).
   - **Not found:** replace with `[Skill "/${commandName}" not found — use the search_skills tool to see what's available]${args ? '\n\n' + args : ''}`.
5. All other messages in the array are returned unchanged.

The modifier never modifies the checkpoint — it operates only on the messages array passed to the LLM.

### 5. `search_skills` LangGraph tool

New file: `api/src/agents/tools/search-skills.tool.ts`.

**Tool name:** `search_skills`
**Description:** Search available skills by keyword. Returns skill names, descriptions, and their slash commands. Call with no argument to list all available skills.
**Input schema:** `{ keyword?: string }`
**Returns:** Array of `{ name, description, slashCommand }` for all matching enabled skills.

Registered in the agent's tool list alongside `wiki_search`, `ask_user`, etc. The agent calls this when it judges that a skill might be relevant to the current task, allowing it to suggest the appropriate slash command to the user without bloating the system prompt with a permanent skill listing.

### 6. `GET /api/v1/skills`

New route file: `api/src/routes/v1/skills.route.ts`.

- `GET /api/v1/skills` — returns `{ skills: SkillSummary[] }`
- Accepts optional `?q=` query parameter; delegates to `skillsManager.search(q)`
- Only enabled skills are returned (via `search()`)
- Used by the UI autocomplete; no authentication required beyond existing session handling

### 7. `ChatInput` — slash-menu autocomplete

The existing `<div data-slot="chat-input-slash-menu" className="hidden" />` stub is replaced with a functional overlay. All slash-menu state is owned locally by `ChatInput` — no new props on `ChatInputProps`.

**Trigger:** Menu opens when `value` starts with `/` and the component is not in a generating state.

**Query extraction:** The query is everything after `/` up to (not including) the first space. If the user has typed `/sum`, the query is `sum`. If the user has typed `/summarize my notes`, the query is `summarize` (the menu has already closed at this point — see dismissal below).

**Fetching:** `GET /api/v1/skills?q={query}` called on each keystroke, debounced ~150ms. Results replace the current list.

**Dismissal:** Menu closes when:
- A skill is selected (Enter, Tab, or click)
- `Escape` is pressed
- A space is typed (command name is complete, user is typing args)
- Value no longer starts with `/`

**Keyboard navigation:**
- `↑` / `↓` — move highlight through results
- `Enter` or `Tab` with a highlighted item — select instead of sending the message
- `Escape` — close menu, focus stays in textarea

**On selection:** Textarea value is replaced with `/{skill-name} ` (trailing space so the user can immediately type args). Menu closes.

**Display:** Absolutely positioned above the textarea, anchored inside `chat-input-body` (which already has `position: relative`). Each row shows the slash command in bold and the description below it. Empty state (no matches) shows "No matching skills."

---

## TODO_LIST.md changes

**#2 Shell Command Execution** gains a coordination note:

> **Shell Command Execution** — depends on: #1; follow-up skill: shell environment, command policy, approval flow (reusing `ask_user` patterns), result captured as a tool call. **Note:** must coordinate with `SkillsManager` script execution — skills can carry JS and Python scripts (`runScript`, `runPythonScript`) that may invoke shell commands; the shell execution policy, approval flow, and audit trail established here should apply uniformly to both agent-initiated shell calls and skill-script-initiated shell calls.

**#11 Skills Integration** description is updated to:

> **Skills Integration** — depends on: #10 (Settings Page UI); `skills-manager` library is complete and wired as of Agent Skills; needs a Settings UI for managing skills: browse installed skills, enable/disable, view `SKILL.md` content, and install new skills by name or from a directory.

`POST /api/v1/skills/:name/run`, skill registration as LangGraph tools, and `GET /api/v1/skills` (already delivered by this item) are removed from #11's description.

---

## Error handling

| Scenario | Behaviour |
|---|---|
| Skill not found | Modifier replaces message with inline error notice; turn continues; model can call `search_skills` to suggest alternatives |
| `SkillsManager` not booted | `lookup()` throws; modifier catches and returns the not-found error notice |
| `skillsRoot` directory missing | Created on startup; `boot()` succeeds with empty catalog |
| `GET /api/v1/skills` with bad `q` | `search()` treats any string as valid; returns empty array for no matches |
| UI fetch fails | Slash menu closes silently; user can still type the slash command manually |

---

## References

- `lib/skills-manager/` — `SkillsManager` library (`search()` method to be added)
- `api/src/services/tools-manager.ts` — singleton pattern to follow
- `api/src/agents/chat-agent.ts` — `createReactAgent` call site for `messageModifier`
- `ui/src/components/chat-input.tsx` — slash-menu stub at line 126
- `docs/ADR.md` ADR-002 — injection timing decision and options comparison
- AgentSkills specification: https://agentskills.io/specification
