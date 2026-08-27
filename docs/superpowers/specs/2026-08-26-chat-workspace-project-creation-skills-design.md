# Chat Skills: /create-workspace and /create-project

Design for [#81](https://github.com/tkottke90/amazing-hashbrown/issues/81).

## Problem

Creating a workspace or project today requires leaving the chat and filling
in the `/workspaces` form. The issue asks for `/create-workspace` and
`/create-project` slash commands that collect the same fields
conversationally and create the resource without leaving the thread.

The issue's dev notes point at the existing "Agent Skills (Slash Commands)"
system (`SkillsManager`, `api/src/services/skills-manager.ts`) as the pattern
to follow — but that system is pure text injection
(`docs/superpowers/specs/2026-08-04-agent-skills-slash-commands-design.md`):
typing `/name` expands into a `SKILL.md` instruction block before the LLM
sees it. It cannot call an API, validate a schema, or render a card. Actually
creating a workspace needs a real callable tool. This design uses both
systems together, each for what it's already good at.

## Architecture

**Two new LangChain tools** (`api/src/agents/tools/create-workspace.tool.ts`,
`create-project.tool.ts`), following the existing tool pattern (see
`wiki-create-domain.tool.ts`): a Zod schema, a handler that performs the
side effect, an SSE event on success. Each tool calls the corresponding
handler function directly — `createWorkspaceHandler` / `createProjectHandler`
— in-process, the same way `wiki_create_domain` calls `registry.create()`
directly rather than making an HTTP round-trip to its own API. This still
satisfies the issue's "single endpoint, one transaction" requirement (same
handler, same code path the HTTP route uses) and means the 409 conflict
handling added below benefits the web form too.

**Two new SKILL.md files**, seeded into `skillsRoot` on boot if missing —
the same "auto-create on first boot" pattern already used for
`config/AGENT.md` and the wiki registry's default domains. Each skill body
is pure instruction text: what fields to collect, in what order, what to
default, and a directive to call the matching tool once fields are
confirmed. Typing `/create-workspace` goes through the existing
`skillExpansionMiddleware` text-expansion path unchanged.

## Reusable pattern: Skill-Gated Tools

The two creation tools are **not** always registered in `STATIC_CHAT_TOOLS`.
Per the "Composition over Customization" principle (`AGENTS.md`), this is
built as one generic, reusable middleware rather than one-off logic for
workspace/project creation:

- `api/src/agents/skill-gated-tools.middleware.ts` exports
  `createSkillGatedToolsMiddleware(registrations: { skillCommand: string; toolNames: string[] }[])`.
  `/create-workspace` → `['create_workspace']`, `/create-project` →
  `['create_project']` are the first two registrations; a future skill adds
  an entry instead of writing new middleware.
- New middleware state: `activeGatedSkill: string | null`.
  `skillExpansionMiddleware` sets it to the matched command name whenever it
  expands a _registered_ gated skill (looked up from the same
  `registrations` list — one source of truth for "which skills gate which
  tools").
- A new `wrapModelCall` hook (first use of this hook in the codebase;
  confirmed available on the pinned `langchain@1.5.2` — its documented
  purpose includes "change system prompt, add/remove tools" per model call)
  resolves `activeGatedSkill` to its registration and filters the tools
  passed to the model down to the always-on set plus whatever that
  registration allows.
- Cleared back to `null` once the matching tool call **succeeds**. Left open
  across a rejection (409/400/5xx) so the agent can retry with corrected
  fields in the same flow without the user retyping the slash command.
  Retyping either slash command overwrites it, so switching flows
  mid-conversation just works. This state lives in the checkpointed graph
  state, so it survives the multiple turns field collection needs.

**Why this exists as infrastructure, not a one-off:** per the project's
context-scarcity goal (`README.md` § Design philosophy), tools that are only
useful for one narrow, user-invoked action shouldn't sit in every turn's
tool list by default. This pattern is expected to be reused as more
chat-invoked actions are added — see `AGENTS.md` § Composition over
Customization for the general principle.

## Field collection

Issue vocabulary → actual API shape:

| Issue field                                                         | `/create-workspace` | `/create-project` | Maps to                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` (required)                                                   | ✓                   | ✓                 | `name` — also the source of `directoryName = slugify(name)` (auto-derived, never asked)                                                                                                                                                                                                                                       |
| `location` (optional, issue proposed default `~/workspaces/{slug}`) | dropped             | dropped           | Replaced: `directoryName` from `name`, `locationRoot` silently defaults to `'projects'` (not asked). The resolved path is shown in the pre-creation confirmation instead of being a separate question — the actual API has no free-form path or slug field, only `locationRoot: 'projects' \| 'temporary'` + `directoryName`. |
| `goal` (optional)                                                   | ✓                   | ✓                 | `goal`                                                                                                                                                                                                                                                                                                                        |
| `wiki_id` (optional)                                                | ✓                   | dropped           | `wikiId`. `/create-project` always provisions a fresh ephemeral wiki (`createProjectHandler` rejects a caller-supplied `wikiId`), so this question doesn't apply there.                                                                                                                                                       |
| git enabled (optional)                                              | ✓                   | ✓                 | `git` boolean, defaults to `false` if unspecified                                                                                                                                                                                                                                                                             |
| `win_condition` (required)                                          | n/a                 | ✓                 | `winCondition`                                                                                                                                                                                                                                                                                                                |
| `due_at` (optional)                                                 | n/a                 | ✓                 | `dueAt`                                                                                                                                                                                                                                                                                                                       |

Conversation flow, driven by the SKILL.md instructions using the existing
`ask_user` tool (already the established path for structured clarification
per `system-prompt.ts`'s `ASK_USER_SECTION`):

1. Parse whatever the user's initial message already supplied.
2. If any required field is missing, call `ask_user` **once**
   (`kind: 'free_text'`) listing every missing required field together —
   never one field per question.
3. Once required fields are present, derive `directoryName`/`locationRoot`
   and any optional-field defaults, then call `ask_user`
   (`kind: 'yes_no'`) summarizing name, goal (if set), resolved path, git
   on/off, and (workspace only) wiki binding — asking the user to confirm
   before creating.
4. **Wiki binding** (`/create-workspace` only): if the user names a wiki,
   the tool validates it against `GET /api/v1/wiki/domains` (matching
   against `id`/`domain`/`tags` — that endpoint has no separate `name`
   field). No match → the agent lists the available domains and asks the
   user to pick one.
5. Only after explicit confirmation does the agent call `create_workspace`
   / `create_project`.

## API changes: name uniqueness and 409

Today, `createWorkspaceHandler`/`createProjectHandler` have no name
uniqueness check at all, and a directory-name collision on disk returns
`400` ("A directory already exists at this location") — not `409`. The
issue requires a clear, stop-and-wait 409 on duplicate name.

New `WorkspaceStore.findWorkspaceByName(name)`, called by both handlers
before any filesystem/DB work. Comparison is case-insensitive: since
`directoryName` is already `slugify(name)`-derived and lowercases
everything, two names differing only by case would already collide on
directory — name uniqueness should follow the same rule for consistency.
A match returns a new `conflict()` helper (`{ status: 409, error: 'A
workspace named "X" already exists.' }`). This is a shared handler change,
so the 409 also benefits the `/workspaces` web form.

Chat error-handling contract:

| API response                                                                                                                                   | Chat behavior                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201` success                                                                                                                                  | Emit SSE event + resource card, clear `activeGatedSkill`                                                                                                                                                                                                |
| `409` (new) — duplicate name                                                                                                                   | Relay the message verbatim, **stop** — no retry, no name-mangling. Wait for the user's next instruction.                                                                                                                                                |
| `400` — missing/invalid field, or the rarer case where two different names slugify to the same directory (e.g. "My Project!" vs "My Project?") | Relay the specific message from the response body. This is the issue's "422 Unprocessable" bucket in spirit — the API uses 400 for all validation failures rather than distinguishing 422, and this design doesn't introduce a new status split for it. |
| `5xx` / thrown network error                                                                                                                   | Tell the user creation failed and suggest the Workspaces page (`/workspaces`) as a fallback                                                                                                                                                             |

## Resource card

**New `ThreadMessage` kind** (`ui/src/types/thread-message.ts`), added to
the existing discriminated union alongside `wiki_update`:

```ts
| {
    kind: 'resource_card';
    id: string;
    resourceType: 'workspace' | 'project';
    name: string;
    goal?: string;
    location: string;
    // For a project, this is the same id as its workspace row (projects
    // share their workspace's id — see workspace-store.ts's NewProjectInput).
    workspaceId: string;   // for the Open link
    seq?: number;
  }
```

Pipeline mirrors the existing `wiki_update` path: tool succeeds →
`getActiveSseWriter(threadId)?.({ type: 'resource_created', ... })` → new
case in `stream-handler.ts` → new `recordResourceCard()` in
`thread-message-writer.ts` (persists a `thread_messages` row, `kind:
'resource_card'`) → UI's `use-thread.ts` turns the SSE/persisted row into
the `ThreadMessage` → new `ResourceCardMessage` component in
`ThreadMessageItem`'s switch.

**Composition, not a generic schema.** `resource_card` keeps its own typed
fields specific to what workspace/project creation actually produces — it
is not a generic `{ resourceKind: string, meta: Record<string, string> }`
bag that every future resource type has to be squeezed into (see `AGENTS.md`
§ Composition over Customization). What _is_ shared is presentation: two
small standalone components —

- `ThreadCardShell` — the bordered-card layout (`rounded-md border
border-border bg-card`, matching `iframe-message.tsx`'s existing card
  treatment)
- `CardBadge` — the labeled chip (matching the existing `wiki_update` badge
  styling)

`ResourceCardMessage` (`ui/src/components/resource-card-message.tsx`)
composes both: type badge (Workspace/Project), name as heading, goal
snippet if set, location in monospace, and an "Open →" link using
`preact-iso`'s `route()` to navigate to `/workspaces/:id`. A future
resource-card kind (e.g. for tasks) gets its own `ThreadMessage` kind and
its own fields, but reuses `ThreadCardShell`/`CardBadge`.

Issue #100 tracks retrofitting `wiki_update` to compose the same shell/badge
and gain a navigation link — explicitly out of scope for this design, filed
as follow-up since it depends on this work landing first.

## Testing

Following `AGENTS.md`'s test taxonomy:

- **Unit**: Zod schemas for the two tools; `findWorkspaceByName` on
  `WorkspaceStore`; `activeGatedSkill` set/clear transitions.
- **Orchestration**: tool → handler → store call sequencing (spy-based,
  in-process call verified with correct args); `wrapModelCall` tool-list
  filtering for gated vs. always-on tools; handler-level 409/400/500
  branches (extends existing `workspaces.handlers.test.ts` /
  `projects.handlers.test.ts` coverage with the new uniqueness check).
- **Eval suite** (new `create-workspace`/`create-project` scenarios,
  `tool-call`/`tool-sequence` types): field-collection batching, 409
  stop-and-wait behavior, tool-gating (tool not called when the skill
  wasn't invoked).
- **UI (Jest)**: `ResourceCardMessage` rendering for both resource types,
  with/without goal; `ThreadCardShell`/`CardBadge` in isolation.
- **E2E**: one `@user-workflow` scenario — type `/create-workspace`, answer
  prompts, see the card, click Open, land on `/workspaces/:id`;
  LLM-dependent parts mocked per `e2e/AGENTS.md`.

## Out of scope / non-goals

- Retrofitting `wiki_update` notifications to the resource-card pattern —
  tracked in #100, depends on this design landing first.
- Extending `POST /api/v1/projects` to accept a caller-supplied `wikiId` —
  the issue's optional `wiki_id` field for `/create-project` doesn't apply
  given the API's current forced-ephemeral-wiki behavior; not changing that
  behavior here.
- A free-form `location` path field on the workspace/project API — this
  design works within the existing `locationRoot`/`directoryName` shape.
- Creating a `'temporary'`-rooted workspace/project via chat — `locationRoot`
  always defaults to `'projects'` and isn't asked about, so `'temporary'`
  stays reachable only through the `/workspaces` web form.
- Generalizing `activeGatedSkill`/`wrapModelCall` filtering beyond the
  registrations list shape defined here; future consumers register into the
  same middleware rather than prompting a redesign, unless a real need for
  something the registration shape can't express shows up.
