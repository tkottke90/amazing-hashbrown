# Document Decomposition & Ingestion Skill (`/ingest-document`)

Design for a built-in, chat-invoked skill that guides the agent through
decomposing a large or poorly-structured document into wiki pages — planning
and confirming the breakdown before writing anything — rather than diving
straight into `wiki_create_page`/`wiki_update_page` calls.

## Problem

The wiki system already has solid mechanics for writing pages
(`lib/llm-wiki`, `api/src/agents/tools/wiki-*.tool.ts`) and a per-domain
policy for what belongs on a page (`SCHEMA.md`'s Page Thresholds and tag
taxonomy, scaffolded by `lib/llm-wiki/src/internal/templates.ts`). Neither
agent that can write to the wiki — the main/workspace chat agent
(`api/src/agents/chat-agent.ts`) or the dedicated Wiki Chat ingestion agent
(`api/src/agents/wiki-ingestion-agent.ts`) — is instructed to do any
up-front planning before it starts calling write tools. For a short, focused
source this is fine; for a long or unstructured document (meeting notes, a
sprawling report, a pasted email thread) the model is left to decide, inline
and without checkpoint, how many pages to create, what to call them, and
whether something overlaps existing content — exactly the kind of judgment
call this codebase otherwise always gates behind an explicit confirmation
(see `create-workspace`, `create-project`, `create-skill` in
`api/src/services/default-skills.ts`).

## Decisions

| Topic | Decision |
| --- | --- |
| Command surface | One new skill, `ingest-document`, added to `DEFAULT_SKILLS` in `api/src/services/default-skills.ts`. Pure instruction text, no new tools, no new middleware, no new routes. |
| Target surface | Main chat and workspace chat only (`chat-agent.ts`) — both already run `createSkillExpansionMiddleware` and already have `buildWikiWriteTools()` bound. The dedicated Wiki Chat (`wiki-ingestion-agent.ts`) is explicitly out of scope: it has no Skill-expansion support today, and wiring that in is a separate, larger change not needed for this skill. |
| Tool gating | **Not** registered in `GATED_SKILL_REGISTRATIONS` (`api/src/agents/gated-skill-registrations.ts`). That registry's filter is a single shared `Set` across every registration — any tool name added to it disappears from the model's tool list whenever a *different* skill (or no skill) is active. Wiki tools (`wiki_locate`, `wiki_orient`, `wiki_search`, `wiki_read_page`, `wiki_create_page`, `wiki_update_page`, `wiki_add_cross_link`, `wiki_lint`) are meant to stay globally available (plain chat, other skills) — gating them under `ingest-document` would be a functional regression, not an inert documentation aid. The skill body references these tool names in prose instead. |
| Decomposition policy | Deferred entirely to each wiki's own `SCHEMA.md` (Page Thresholds, tag taxonomy) via `wiki_orient`, rather than re-specifying generic splitting rules in the skill body. Avoids two sources of truth for the same judgment call — the exact smell `AGENTS.md`'s "Composition over Customization" section calls out. |
| Document size | Scoped to documents that fit in the model's context window, however messy/unstructured. Documents that exceed context would need a real chunking mechanism (new tooling, multi-turn accumulation) — explicitly out of scope for this skill. |
| Interaction model | Agent builds a plan, states it as a numbered list in its own reply text, then — same turn — calls `ask_user` (`kind: "multiple_choice"`) with exactly two choices: `"Yes, proceed"` / `"No — I'll explain what to change"`. The question references "the plan above" rather than repeating it, keeping the `ask_user` payload small. A "No" ends the turn with no further tool calls; the user's next message carries their feedback and the agent re-plans and re-gates. |
| Provenance | Each `wiki_create_page`/`wiki_update_page` call in the execution phase passes `sourceText` with the actual excerpt the page content came from (not a paraphrase), so the original document is preserved as a raw source — an easy optional param to drop, called out explicitly in the skill body. |
| Post-write cleanup | After the write batch: `wiki_add_cross_link` between genuinely related pages touched this turn, then `wiki_lint` on the domain, fixing anything it surfaces before finishing — same norm the Wiki Chat ingestion agent's own `PAGE_STRATEGY_SECTION` already follows. |
| Error handling | Tool-level failures (unknown wiki, forbidden, archived, duplicate-on-write) are relayed as-is and the turn stops — the existing tools already return actionable messages; the skill doesn't duplicate that logic. |

## Flow

1. **Resolve the domain.** If this is a workspace chat with a bound wiki
   domain, use it. Otherwise, if the user named a domain, use it; if not,
   call `wiki_locate` and ask if ambiguous — the same pattern every other
   wiki-writing flow in this codebase already follows.
2. **Orient.** Call `wiki_orient` on that domain before judging anything.
   Its `SCHEMA.md` defines this domain's tag taxonomy and Page Thresholds
   (when something earns its own page vs. folds into an existing one vs. is
   too minor to record) — apply *that* domain's rules, not a generic one.
3. **Read and segment.** Read the document provided (pasted as the slash
   command's args, or an attachment surfaced by the existing
   `attachmentAwarenessMiddleware`) and identify the distinct entities,
   concepts, comparisons, or Q&A pairs that clear this domain's threshold
   for a page. Passing mentions and minor details don't get their own
   entry.
4. **Check for overlap.** For each candidate topic, call `wiki_search` (and
   `wiki_read_page` on anything relevant) to check for overlap with content
   already in the wiki.
5. **Build the plan.** One line per topic: new page (title + type) / append
   to existing page (which page, what's being added) / skip (why it
   doesn't clear the threshold). A short, single-topic document can produce
   a one-item plan — don't manufacture extra splits to look thorough.
6. **Present and gate.** State the plan as a numbered list in the reply
   text, then — in that same turn — call `ask_user` with
   `kind: "multiple_choice"`, choices `"Yes, proceed"` and
   `"No — I'll explain what to change"`. The question text only asks for
   approval of "the plan above"; it does not repeat the list. This applies
   even when the request reads like a go-ahead (e.g. "here's our onboarding
   doc, file it in the wiki" is still a request to run this skill, not a
   bypass of the confirmation step).
7. **Branch on the answer.**
   - **"Yes, proceed"** → continue to step 8.
   - **"No — I'll explain what to change"** → stop the turn entirely; don't
     guess at a revision or ask a follow-up question. Wait for the user's
     next message, revise the plan from their feedback, restate it, and run
     the same gate again (back to step 6).
8. **Execute.** Call `wiki_create_page`/`wiki_update_page` per confirmed
   plan item, passing `sourceText` with the actual excerpt each page's
   content came from.
9. **Cross-link.** Call `wiki_add_cross_link` between pages touched this
   turn where they're genuinely related.
10. **Lint.** Call `wiki_lint` on the domain and fix anything it surfaces
    before finishing.
11. **Relay failures.** If any write call reports a conflict or validation
    error, relay it as-is and stop — don't retry with a workaround (same
    rule every other write-capable skill in `default-skills.ts` follows).

## Data flow (example)

1. User (main or workspace chat) types `/ingest-document` with the document
   pasted or attached.
2. `createSkillExpansionMiddleware` expands it, sets
   `activeSkill: 'ingest-document'` — no new middleware involved.
3. Agent resolves the domain (bound workspace wiki, or `wiki_locate`), then
   `wiki_orient`s.
4. Agent reasons over the document, calling `wiki_search`/`wiki_read_page`
   per candidate topic.
5. Turn ends with: plan text + an `ask_user` (`multiple_choice`) call →
   graph `interrupt()`s; the pending HITL prompt shows in the SSE stream
   same as any other skill.
6. User clicks **"Yes, proceed"** or **"No — I'll explain what to
   change."**
7. On "Yes": graph resumes, agent calls
   `wiki_create_page`/`wiki_update_page` per item (with `sourceText`),
   `wiki_add_cross_link`, `wiki_lint`, summarizes.
8. On "No": graph resumes with no further tool calls that turn; the user's
   next message carries their feedback, agent revises the plan and loops
   back to step 5/6.

## Error handling / edge cases

- **No document actually provided** (empty args, no attachment) → the
  skill body tells the agent to ask what to ingest rather than inventing
  content.
- **Domain ambiguous** → falls through to the existing `wiki_locate` + ask
  pattern; nothing new to build.
- **`wiki_create_page` returns `duplicate` at write time** even though the
  plan said "new" (stale search results, a race) → the tool's own response
  already instructs reading the blocking page and appending or forcing with
  a distinguishing title; the skill doesn't duplicate that logic.
- **Unavailable/unknown/forbidden/archived wiki** → existing tools already
  return clear messages; covered by step 11's "relay as-is and stop."
- **Trivial/short input** → a one-item plan is fine (step 5).
- **`wiki_lint` finds issues post-batch** → fix before finishing, same norm
  as the existing Wiki Chat ingestion agent's `PAGE_STRATEGY_SECTION`.

## Testing

This is a pure instruction-text addition to `default-skills.ts` — no new
runtime logic, so there is nothing here for a developer unit/orchestration
test to exercise (the "pure data" exemption in the root `AGENTS.md`'s
Testing Blacklist applies the same way it does to every other entry in that
file).

Per the root `AGENTS.md`'s Evaluation-Driven Development rules, this is an
LLM-facing feature and needs a new eval suite,
`suites/ingest-document.yaml`, following the pattern of
`create-workspace-project.yaml`/`file-conflict-resolution.yaml`. At minimum:

- A single-topic document → a one-item plan, no unnecessary splitting.
- A messy multi-topic document → multiple new pages, correctly typed.
- A document overlapping existing wiki content → append, not a duplicate
  page.
- The "No, I'll explain" revision loop → plan is actually revised from the
  user's feedback, not re-presented unchanged.
- Empty/trivial input → the agent asks what to ingest rather than
  inventing content.

Per rule 1, at least one scenario should exist and fail before the skill
body is considered final, then the body gets tightened against real model
runs the same iterative way the existing `create-workspace`/`create-project`
entries' comment history shows evidence of. Running those evals requires a
local model provider this session cannot reach — scenario authoring and the
first implementation pass happen here; the actual eval run and any
resulting tightening rounds are handed off to the user with the exact
`npm run eval -- --suite ingest-document --model <provider> --judge-model <provider>`
command.

## Out of scope

- Wiki Chat / `wiki-ingestion-agent.ts` support (would require adding
  Skill-expansion middleware to that agent — a separate change).
- Documents larger than the model's context window (would require a real
  chunking mechanism, not just a skill).
- Any change to `lib/llm-wiki`, the wiki tools, or `SCHEMA.md`'s Page
  Thresholds themselves — this skill only tells the agent to apply what
  already exists, in a planned, confirmed order.
