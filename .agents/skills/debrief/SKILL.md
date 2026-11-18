---
name: debrief
description: Get grounded on an abstract GitHub issue, ticket, or topic before engaging it — scouting the code, history, and vocabulary it touches into a short briefing, then handing off into grilling with that context loaded. Use when an issue or topic is too unfamiliar to ask sharp grilling questions about yet, or the user wants to get up to speed / oriented / ramped up on something before deciding anything.
---

A concrete issue, ticket, or topic has arrived **cold**: there's something specific to engage with, but not yet enough footing in the codebase, its history, or its vocabulary to ask a sharp question about it. Debriefing fixes that footing in one session, then hands off into `grilling` once the ground is solid.

This sits between two other skills. `grilling` assumes you already know the shape of the problem well enough to ask narrow questions. `wayfinder` is for work too large to see across in one session, charted through an issue tracker. Debrief is neither: it's the warm-up lap before grilling can start, sized to one session, with nothing to track once it's done.

## Steps

1. **Pin the subject.** Pull the full text of the issue, ticket, or topic — body, comments, and anything it links to — not just the title. If it's thin (a one-line issue, a name with no description), say so; that's itself a finding, not a blocker.

2. **Scout, don't ask.** Finding facts is your job, never the user's — if you can look it up, don't ask for it. Dispatch fact-finding across these threads, in parallel:
   - the code paths the issue's own terms touch (grep for them, then read what matches)
   - recent history on those paths: `git log`, blame, merged PRs that last changed them
   - existing docs, ADRs, or `GLOSSARY.md` entries covering the terms involved
   - for anything resting on a third-party API or library's actual behavior, call the Skill tool with `research` instead of exploring it yourself — that skill's job is primary-source rigor, this one's isn't

   Done when every dispatched thread has reported back and, for each term the issue uses, you can say where it's defined or implemented — not just that you looked.

3. **Escalate if it doesn't fit.** If scouting reveals the issue is actually several decisions deep, or spans more ground than one session can hold, stop here. Say so, and offer to hand off to `wayfinder` instead of continuing to the briefing below.

4. **Write the briefing.** Short, in chat, not committed anywhere unless the user asks:

   ```markdown
   ## What it is
   <the concrete ask, in the issue's own terms, one or two lines>

   ## Already exists
   <relevant code/docs scouting found — paths, not restatements of their contents>

   ## Open questions
   <questions now sharp enough to ask — these seed grilling's first round>

   ## Still fuzzy
   <anything scouting couldn't pin down>
   ```

   Done when every entry under **Open questions** is phrased sharply enough to hand to `grilling` as a frontier question verbatim.

5. **Calibrate.** Show the user the briefing. Ask once whether it's accurate and complete — a single check, not a grilling round. Fold in any correction they give.

6. **Hand off.** Call the Skill tool with `grilling`, carrying the briefing's **Open questions** in as its first round instead of starting from zero. If scouting surfaced terms worth recording, call the Skill tool with `domain-modeling` too.
