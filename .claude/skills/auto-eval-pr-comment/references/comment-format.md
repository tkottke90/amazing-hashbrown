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
   - `` ## `wiki-write` eval results ``
   - `` ## Auto-eval loop: `web-fetch` suite — all providers passing ``

2. **Intro paragraph** — which suite, which models (bold the eval ids),
   which judge, how many rounds to convergence, and the converging
   commit(s). One paragraph.

3. **Models used** (optional table; include when the eval ids alone are
   cryptic) — one row per model from `config/config.yaml` `providers:`:

   | Eval model id | Served as | Provider |
   |---|---|---|
   | `ornith` | `user.Ornith-1.0-35B-GGUF` | local OpenAI-compatible server |

4. **Score trajectory** — from `runs:`. Two shapes in the wild; pick by
   round count:
   - Compact table (`| Model | Initial | Converged |`) when the journey
     itself isn't the story.
   - Per-round `###` sections (`### Round 1 — ornith 4/5, glm 4/5, local
     2/5 (all below the 0.85 threshold)`) when the diagnosis differed per
     round. State scores as `passed/total`, and name the threshold when
     explaining why a high fraction still failed.

5. **Findings** — the heart of it. One bullet per failure worth
   narrating, from `log[].summary` / `log[].modifications`:
   - **Bold lead** stating the scenario id(s) and the point ("**wfetch-003
     failed for all three models, but two of them were right.**").
   - Classify per the loop's diagnosis buckets: scenario bug / real
     prompt gap / model capability ceiling.
   - Say what fixed it and where, with the round's commit SHA in
     backticks (`` fixed in `f4b57ab` ``).

6. **Remaining known issues** — ceiling flags and open nondeterminism,
   with the evidence that earned the flag ("three occurrences across
   three fixtures, each already maximally explicit"). If nothing remains,
   say so in one line ("No capability-ceiling flags this time"). Never
   omit the section to make the run look cleaner than it was.

7. **Audit-trail pointer** — name the `eval-logs/auto-eval-<timestamp>.yaml`
   file and note it's untracked (`eval-logs/` is gitignored), so the
   comment is the durable record.

8. **Cross-reference** — if the session produced comments for other
   suites on the same PR, link them in prose ("See the `wiki-navigation`
   results comment above").

9. **Footer** — attribution line, set off by `---` or a blank line:

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
