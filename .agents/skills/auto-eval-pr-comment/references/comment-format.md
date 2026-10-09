# Eval-results comment format

Distilled from the two real comments this repo has shipped. Read at least
one before writing yours — they set the tone (concrete, scenario-by-
scenario, honest about what didn't converge):

```bash
# PR #37, wiki-write suite (table-heavy variant)
gh api repos/tkottke90/amazing-hashbrown/issues/comments/5096283370 --jq '.body'
# PR #44, web-fetch suite (per-round narrative variant)
gh api repos/tkottke90/amazing-hashbrown/issues/comments/5168668022 --jq '.body'
```

## Structure

Every section maps to something in the auto-eval YAML — nothing in the
comment should be inventable without the log open next to you.

1. **Heading** — `##`, names the suite in backticks, states the outcome.
   Either shape used so far is fine:
   - ``## `wiki-write` eval results``
   - ``## Auto-eval loop: `web-fetch` suite — all providers passing``

2. **Commit line** — immediately below the heading, one bold-labeled line
   naming the exact commit these results were evaluated against, linked to
   GitHub:

   ```
   **Evaluated commit:** [`a1b2c3d`](https://github.com/tkottke90/amazing-hashbrown/commit/a1b2c3d1234567890abcdef1234567890abcdef)
   ```

   This is the commit that actually got run through the eval loop — the
   last round's `commit` in the audit trail — not necessarily the branch's
   current HEAD, which may have moved since the loop finished. Put it here
   rather than folding it into prose: when a reviewer (human or an AI
   coding agent) opens the comment, this is often the first thing they
   check, and it should be answerable without reading past the heading.
   When one session posts comments for multiple suites on the same PR,
   this SHA must be identical across all of them — that's how a reader
   confirms the comments describe the same code.

3. **Intro paragraph** — which suite, which models (bold the eval ids),
   which judge, how many rounds to convergence. One paragraph. (The
   converging commit itself now lives in the commit line above — no need
   to repeat the full SHA here, though naming the round is fine, e.g. "by
   round 3".)

4. **Models used** (optional table; include when the eval ids alone are
   cryptic) — one row per model from `config/config.yaml` `providers:`:

   | Eval model id | Served as                  | Provider                       |
   | ------------- | -------------------------- | ------------------------------ |
   | `ornith`      | `user.Ornith-1.0-35B-GGUF` | local OpenAI-compatible server |

5. **Score trajectory** — from `runs:`. Two shapes in the wild; pick by
   round count:
   - Compact table (`| Model | Initial | Converged |`) when the journey
     itself isn't the story.
   - Per-round `###` sections when the diagnosis differed per round —
     e.g. `### Round 1 — ornith 4/5, glm 4/5, local 2/5 (all below the 0.85 threshold)`.
     State scores as `passed/total`, and name the threshold when
     explaining why a high fraction still failed.

   When the audit log's final round for a model/suite pairing carries a
   `baseline` field (see `auto-eval-loop/SKILL.md`'s Field notes), append
   it to that score, in whichever shape (table or narrative) this comment
   uses:

   | Model    | Initial | Converged | Baseline |
   | -------- | ------- | --------- | -------- |
   | `ollama` | 13/18   | 18/18     | 13.2 ± 0.4 → **IMPROVEMENT** (+4.8) |

   or in narrative form: "`ollama` converged at 18/18 — baseline is
   13.2 ± 0.4 (`ollama-gptoss20b`), so this is an **IMPROVEMENT** (+4.8)."
   For a pairing with no `baseline` field anywhere in the log, omit the
   column/clause entirely — never fabricate it or show it as "N/A" (which
   would read as "checked, found nothing" rather than "not checked").

6. **Findings** — the heart of it. One bullet per failure worth
   narrating, from `log[].summary` / `log[].modifications`:
   - **Bold lead** stating the scenario id(s) and the point ("**wfetch-003
     failed for all three models, but two of them were right.**").
   - Classify per the loop's diagnosis buckets: scenario bug / real
     prompt gap / model capability ceiling.
   - Say what fixed it and where, with the round's commit SHA in
     backticks (`` fixed in `f4b57ab` ``).

7. **Remaining known issues** — ceiling flags and open nondeterminism,
   with the evidence that earned the flag ("three occurrences across
   three fixtures, each already maximally explicit"). If nothing remains,
   say so in one line ("No capability-ceiling flags this time"). Never
   omit the section to make the run look cleaner than it was.

8. **Audit-trail pointer** — name the `eval-logs/auto-eval-<timestamp>.yaml`
   file and note it's a local, session-scoped working file by design
   (`eval-logs/` is gitignored on purpose, not an oversight), so this
   comment is the durable, reviewable record instead.

9. **Cross-reference** — if the session produced comments for other
   suites on the same PR, link them in prose ("See the `wiki-navigation`
   results comment above").

10. **Footer** — attribution line, set off by `---` or a blank line:

   ```
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   ```

## Style notes

- Scenario ids, tool names, file paths, SHAs: always backticked.
- Numbers always comparative — "5/5, up from 2/5", not just "passes".
- Credit the models when they were right and the scenario was wrong;
  that distinction is the loop's whole value.
- Length: both real examples are ~30–40 lines of Markdown. A one-round
  all-pass run can be much shorter; don't pad.
- Baseline verdict words (`REGRESSION`/`IMPROVEMENT`/`WITHIN_BASELINE`):
  bold, matching how scenario ids and SHAs are already backticked.
