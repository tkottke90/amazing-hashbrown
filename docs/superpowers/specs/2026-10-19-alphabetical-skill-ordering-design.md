# Alphabetical Skill Ordering — Design

**Date:** 2026-10-19
**Status:** Draft

---

## 1. Problem & Root Cause

Skills appear to be listed in a fixed, non-random-looking order on the Settings > Skills page (`ui/src/pages/settings/skills-list.tsx`) and in the chat slash-command menu (`ui/src/components/chat-input.tsx`), which reads as "chronological" (by creation/discovery) to a user scanning the list. It is not actually chronological, and no field backs that reading: `SkillSummary` (`lib/skills-manager/src/types.ts:21-29`) and its UI projections, `SkillListItem` (`ui/src/services/skills-manage-api.ts:8-19`) and `SkillInfo` (`ui/src/services/skills-api.ts:1-10`), carry no `createdAt` or category field at all.

**Root cause:** `SkillsManager.boot()` (`lib/skills-manager/src/skills-manager.ts:64-99`) populates its cache — a `Map` — from a `Promise.all` over per-directory frontmatter reads. Insertion order is whichever read settles first, a scheduler race rather than a deliberate order. `list()` (`skills-manager.ts:101-110`, `Array.from(this.cache.values())`) and `search()` (`skills-manager.ts:112-122`, which filters `list()`'s output) both inherit that race order as-is. Neither `skills-list.tsx` nor `chat-input.tsx` sorts what they receive — both render the API response order directly (`skills-list.tsx:56-107`; `chat-input.tsx:546-549`, `640-672`).

---

## 2. Fix: Sort Once, at the Source

Add the sort inside `SkillsManager.list()` (`lib/skills-manager/src/skills-manager.ts:101-110`), sorting the materialized array by `name` with a case-insensitive, locale-aware comparator (`localeCompare`) before returning it. Add a stable secondary comparator on `slashCommand` (ascending) for the case of two identical `name`s — defensive only; the cache is keyed uniquely, so two entries sharing a `name` is expected to be unreachable in practice, but the comparator should not depend on that.

`search()` needs no separate change: it already filters `list()`'s return value, so once `list()` returns alphabetical order, `search()`'s filtered results preserve that order for free.

This is the only production code change needed. Neither `skills-list.tsx` nor `chat-input.tsx` requires any edit — both already just render whatever order the API gives them, so fixing the source fixes both surfaces named in the request, plus any current or future consumer of `GET /api/v1/skills` / `GET /api/v1/workspaces/:id/skills` (`api/src/routes/v1/skills.handlers.ts:145-156`).

**Why fix it here rather than in each UI component:** the project's composition-over-customization principle (root `AGENTS.md`) favors one shared mechanism over duplicated logic when the same behavior is needed in multiple places. Sorting independently in `skills-list.tsx` and `chat-input.tsx` would be two copies of the same comparator and would leave the underlying non-determinism in the API/cache layer unfixed for anyone else reading it. This was weighed against a dedicated ADR and judged not to meet that bar — see §4.

---

## 3. Testing

Unit tests only, added to the existing `lib/skills-manager/test/unit/skills-manager.test.ts`:

- `list()` returns skills ordered alphabetically by `name`, case-insensitively (e.g. a lowercase-leading name sorts correctly relative to an uppercase-leading one).
- `search()`'s filtered results preserve that alphabetical order.
- Two skills sharing a `name` (if constructible in a test fixture) break the tie by `slashCommand` ascending.

No changes to `skills-list.tsx`, `chat-input.tsx`, or their existing tests (`ui/test/chat-input.test.tsx`) are required, since no UI-level sort logic is being added.

**Known pre-existing gap (not addressed by this change):** `skills-list.tsx`, `skills-panel.tsx`, and `use-skills-panel.ts` have no test coverage at all today, which is already a violation of this repo's "all application code must have tests" rule, independent of this fix. Tracked as a separate follow-up rather than folded into this change's scope.

---

## 4. Domain Modeling Review

Checked against `GLOSSARY.md` and `docs/adr/`: both are currently scoped entirely to the Dashboard Widgets subsystem and contain no Skill-related language, so there is nothing in either to reference or conflict with for this change.

No glossary term was added. "Alphabetical order" introduces no new domain concept, entity, or rule — it's sort behavior, not vocabulary, and `GLOSSARY.md` is reserved for domain language, not implementation decisions.

No ADR was written. Evaluated against the three-part bar (hard to reverse; surprising without context; result of a genuine trade-off): the fix is cheap to reverse (a small, localized code move), and it is not surprising without context — the root `AGENTS.md` composition-over-customization principle already explains the "one mechanism, not duplicated per-consumer logic" choice. Only the third criterion (a real trade-off was weighed) was clearly met, so the bar for an ADR was not reached.

---

## 5. Out of Scope

- Any grouping/sectioning of skills by `source` (`global`/`repo`) or by enabled/disabled state — neither view groups today, and alphabetical sort applies across the flat list as-is, unchanged from current filtering behavior.
- Giving the slash-command menu relevance-ranked (fuzzy) search like the separate `#tool-name` autocomplete's `toolMatchRank` (`chat-input.tsx:148-161`). The slash menu's substring filter is unchanged; alphabetical order only governs the order of matches, not how they're matched.
- Backfilling full test coverage for `skills-list.tsx` / `skills-panel.tsx` / `use-skills-panel.ts` (see §3).
- Introducing a shared/generic sort utility module. There is no second call site after this fix (the UI components don't sort), so there is nothing to generalize.
