# Research: How Comparable Products Gate Unsolicited AI Suggestions

Research for [issue #389](https://github.com/tkottke90/amazing-hashbrown/issues/389),
a child of the Wayfinder map
[issue #386](https://github.com/tkottke90/amazing-hashbrown/issues/386)
("Collaboration Platform — Suggestion & Pull mechanisms").

## 1. Overview of the Question

`amazing-hashbrown` is being extended with a "Suggestion" mechanism: the
agent surfaces something unprompted (an observation, a risk, a proposal) for
the human to act on or dismiss, and never takes unprompted action itself.
The open design question this survey grounds: **what should trigger such a
suggestion to fire, and what gates/rate-limits keep it from becoming an
annoying backseat driver?**

This doc surveys five comparable products — GitHub Copilot (inline
suggestions and code review; Copilot Workspace's status is addressed and
flagged as unverifiable), Linear's Triage Intelligence, Notion AI Autofill,
Todoist's AI Assistant features, and VS Code's inline/ghost-text suggestions
— against three questions for each: **(a)** what signal triggers the
suggestion, **(b)** what dismissal/snooze/frequency controls the user has,
and **(c)** what UI shape the suggestion takes. Findings are traced to
official vendor documentation; anywhere only a secondary source (blog,
aggregator) could be found, that's called out rather than presented as
sourced fact.

## 2. Information Found

### 2.1 GitHub Copilot — inline (ghost-text) suggestions

**Source: VS Code official docs**,
[code.visualstudio.com/docs/copilot/ai-powered-suggestions](https://code.visualstudio.com/docs/copilot/ai-powered-suggestions)
(also mirrored at `.../docs/editing/ai-powered-suggestions`).

- **(a) Trigger.** Purely ambient and keystroke-driven: "You should see
  inline suggestions from Copilot as you type." There is no separate
  "should I suggest" judgment call surfaced in the docs — every keystroke is
  a potential trigger, gated only by `editor.inlineSuggest.minShowDelay`
  ("Time in milliseconds to wait before showing inline suggestions. Default
  is `0`."). An explicit pull-trigger also exists: the **Trigger Inline
  Suggestion** command, useful on metered connections where automatic
  requests are suppressed but "requests already in progress continue" and
  explicit triggers still work. A related but distinct mechanism, **Next
  Edit Suggestions**, fires after a related edit elsewhere in the file
  rather than at the current cursor position.
- **(b) Dismissal/snooze/frequency.** No frequency cap — the only throttle
  is the show-delay setting. What exists instead is binary and
  user-initiated: **Escape** dismisses the current suggestion with no
  cooldown; a **Snooze** command (via the Status Bar Copilot menu) adds five
  minutes of suppression per press, reversible with **Cancel Snooze**; and
  `github.copilot.enable` toggles the feature per-language (with `*` as the
  default for all languages). There's no adaptive "it's firing too often,
  back off" behavior — only user-pulled levers.
- **(c) UI shape.** Dimmed inline **ghost text** at the cursor, with a
  hover-revealed **toolbar** (next/previous to cycle alternative
  completions, controlled by `editor.inlineSuggest.showToolbar`). Next Edit
  Suggestions instead render as a **gutter arrow** pointing toward the edit
  location, opening a menu on hover; larger edits render side-by-side or
  below the code (`editor.inlineSuggest.edits.renderSideBySide`). Accept is
  **Tab** (whole suggestion), word-level via Ctrl+Right/⌘→, or line-level via
  a dedicated command — i.e. the UI supports partial, granular acceptance,
  not just all-or-nothing.

### 2.2 GitHub Copilot — automatic code review (a second, PR-level trigger)

**Source: GitHub official docs**,
[docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle](https://docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle).

- **(a) Trigger.** Event-based, not ambient: a repository rule can be set to
  review "on open, on draft, or on every new push." For the push case,
  Copilot "reevaluates substantial updates as the pull request evolves" —
  the docs don't define "substantial," so the exact re-trigger threshold is
  opaque even to a reader of the official docs. Manual triggering is also
  available by requesting a review from Copilot under **Reviewers**.
- **(b) Dismissal/frequency controls.** The tutorial page does not describe
  any throttle, cooldown, or comment-volume cap for the automatic path —
  the only lever found is the repository-rule toggle itself (turn off the
  "run on every new push" sub-setting to stop re-review on each push, or
  switch to manual-only). Cost is also a soft deterrent by design: usage is
  billed against the PR *author's* premium-request quota, not the
  reviewer's.
- **(c) UI shape.** Delivered as a GitHub PR **review** (not ambient/inline
  like ghost text) — "high-confidence feedback" and "major comments" that
  the author is expected to "resolve" as the PR evolves. This is a
  fundamentally different shape from 2.1: a discrete, timestamped review
  object attached to the PR thread, not a transient in-editor overlay.

**Note on Copilot Workspace:** the ticket asks specifically about "Copilot
Workspace." No official GitHub changelog or docs page confirming or denying
its current status could be found in this search — results conflicted
between "became generally available in 2026" and "not a standalone feature"
(neither from an official GitHub source). This is reported here as an
**unverified gap** rather than guessed at; the two Copilot mechanisms above
(inline suggestions, automatic code review) are both independently and
officially documented, and are treated as the representative "Copilot"
data points for this survey instead.

### 2.3 Linear — Triage Intelligence

**Source: Linear official docs**,
[linear.app/docs/triage-intelligence](https://linear.app/docs/triage-intelligence).

- **(a) Trigger.** Scoped to a specific workflow moment, not ambient: "Every
  future issue that enters triage is assessed against the rest of your
  data." Suggestions are generated from "historical trends evaluated against
  the current issue's content," and duplicate/relation suggestions fire
  specifically on "strong semantic similarity" — i.e. the trigger has an
  implicit confidence floor rather than firing on every issue indiscriminately.
  Processing is asynchronous and bounded: "expected to take 1-4 minutes." A
  second, user-pulled trigger exists for issues outside Triage: the
  `Cmd`/`Ctrl`+K palette's **Find Suggestions** command runs the same
  analysis on demand.
- **(b) Dismissal/frequency controls.** This is the most granular
  gating model in the survey — controls exist at three levels:
  - **Workspace level:** an admin-only AI on/off toggle.
  - **Team level:** each team can turn Triage Intelligence off
    independently, and can restrict "Include suggestions from" to that
    team and its sub-teams (scoping the data the model draws on, not just
    whether it runs).
  - **Property level:** for each property type (team, project, assignee,
    label), the team chooses whether suggestions **appear, are hidden, or
    are auto-applied** — a three-state control, not just on/off — and can
    filter to specific values. Sub-teams inherit the parent's rule but can
    override it.
  - **Per-suggestion:** accept, decline, or inspect the model's reasoning;
    for relation suggestions specifically, accept, dismiss, or follow the
    reference.
  - **Guidance, not frequency:** teams/sub-teams/workspace can each attach
    free-text guidance to steer suggestion *content*, with "the most local
    guidance... considered first and weighted most heavily" — this shapes
    quality, not firing rate. No explicit cooldown/rate-limit construct was
    found in the docs.
- **(c) UI shape.** Not a popup or notification — property suggestions
  "appear alongside suggested duplicates and when issues are in Triage,"
  i.e. inline in the issue's own property area. Reasoning is surfaced in a
  dedicated pane under the issue title (opened on click, while
  processing or afterward from an overflow menu) — closer to an
  **ambient, in-context panel** than a dismissible toast.

### 2.4 Notion AI — Autofill

**Source: Notion official help docs**,
[notion.com/help/autofill](https://www.notion.com/help/autofill).

- **(a) Trigger.** Entirely declarative/user-configured, not inferred by the
  model: for Basic Autofill, the user picks the trigger — "manually, on
  page create, or on page edits." Custom Agent Autofill adds a fourth
  option, **schedule** (time-based, independent of any page activity).
  There is no "the model decided this was worth surfacing" trigger here —
  the human pre-commits to exactly when the feature runs, before any
  suggestion exists.
- **(b) Dismissal/frequency controls.** Because the trigger is
  pre-committed rather than per-instance, there's no per-suggestion
  dismiss/snooze UI documented. The gating happens *before* the run, via
  configuration: a per-property on/off switch ("make sure AI Autofill is
  turned on for the property"), and conditional guards written into the
  instructions themselves — "Only fill this property if it is empty" or
  "Only fill this property if Status is In Progress." Frequency is
  whatever the configured trigger implies (e.g. "on page edits" fires once
  per edit, "schedule" fires on a timer); no additional throttle is
  documented.
- **(c) UI shape.** No preview/approval surface — Autofill writes the
  property value directly rather than proposing it for review first.
  Custom Agent can "update multiple properties in one run" and can cite
  sources for web-derived fills, but the docs don't describe how those
  citations are displayed. The explicit caveat Notion gives users — "we
  recommend that you always check the accuracy of content from Notion AI
  before relying on it" — implicitly concedes there's no in-UI review step
  before the value lands.

### 2.5 Todoist — AI Assistant features (Filter Assist, Task Assist, Email Assist)

**Source: Todoist official help center**,
[todoist.com/help/articles/introduction-to-todoist-assist-KgPP22q5O](https://www.todoist.com/help/articles/introduction-to-todoist-assist-KgPP22q5O).

- **(a) Trigger.** All three documented Assist features are **pull, not
  push** — none fires on an ambient signal; all require an explicit user
  action first:
  - **Filter Assist:** user clicks "Try it" in a banner, types a
    description, clicks Send — the suggestion exists only after that
    request.
  - **Task Assist:** ships **off by default** ("Task Assist isn't enabled
    in your Todoist account by default") and requires installing a
    separate browser extension or desktop app before any suggestion
    surface exists at all.
  - **Email Assist:** requires an explicit settings opt-in, then is
    triggered by the user forwarding an email to a project's address — the
    "suggestion" (a new task) only appears because the user manually
    routed input to it.
- **(b) Dismissal/frequency controls.** Because every trigger is
  user-initiated, there's no documented dismiss/snooze/frequency-cap
  mechanic for individual suggestions — the control point is upstream,
  at opt-in/opt-out: Email Assist is toggled in settings; Task Assist is
  "off until you set up the extension" and can be removed "at any time";
  Filter Assist's own docs put the philosophy plainly: "You can use Filter
  Assist when you need it or ignore it completely." No per-instance
  accept/decline affordance is documented because the feature doesn't run
  until asked.
- **(c) UI shape.** Filter Assist is a **banner** with a request field and
  Send button, plus an explicit "Add filter" button to accept the result
  (an explicit confirm step, not auto-applied). Email Assist's output is
  just an ordinary task appearing in the target project — no distinct
  "suggestion" chrome at all. Task Assist's surface (rewrite/breakdown/
  sub-task suggestions) is documented by feature list only; the specific
  presentation (menu item vs. inline) isn't described in the fetched page.

### 2.6 Cross-cutting patterns relevant to the design question

Looking across all five products together:

1. **Every product separates "does this fire at all" from "how does it fire
   this time."** The gate is almost always a *configuration decision made
   in advance* (a toggle, a trigger choice, a per-property/per-team rule),
   not a runtime judgment the AI makes about whether *this particular*
   moment warrants interrupting the user. The one partial exception is
   Linear's semantic-similarity floor for duplicate suggestions and GitHub
   Copilot code review's undefined "substantial update" re-trigger — both
   gesture at a confidence/significance threshold, but neither product
   documents the threshold's mechanics.
2. **The products that proved least "naggy" in their own docs are the ones
   with the narrowest, most predictable trigger surface** (Linear: one
   workflow moment — issue enters Triage; Notion: a user-chosen trigger
   enumerated from a fixed, small list) rather than an open-ended "whenever
   the model notices something" trigger. Copilot's inline suggestions,
   the broadest/most frequent of all five, compensate by pushing dismissal
   cost to near-zero (Escape, no cooldown) and giving a blunt, five-minute
   escalation valve (Snooze) rather than smarter triggering.
3. **Granularity of control tends to scale with how invasive the
   suggestion is.** Linear's three-state (show/hide/auto-apply)
   per-property control exists because the suggestion *changes issue
   data*; Todoist's and Notion's gates are coarser (on/off, trigger choice)
   because the user already had to initiate or pre-configure the run.
   Copilot's PR-review mechanism, the most consequential of the five
   (it produces a durable, authored review object other people see), has
   the *least* granular control documented — only a repo-level rule toggle
   — which stands out as a possible gap worth not repeating.
4. **No product surveyed documents an adaptive/learned backoff** (e.g.
   "stop suggesting this category after N dismissals"). Every frequency
   control found is a static, user-set lever — a snooze timer, an on/off
   switch, a trigger choice — not a system that infers annoyance from
   dismissal history. If `amazing-hashbrown` wants suggestions to self-tune
   based on how often a human dismisses a given class of suggestion, that
   would be a departure from precedent, not a continuation of it.
5. **UI shape tracks reversibility.** Products whose suggestion is a
   proposal pending explicit accept (Copilot ghost text's Tab/Escape,
   Linear's accept/decline, Todoist's Filter Assist "Add filter" button)
   put the suggestion in a visibly provisional shape (ghost text, a
   pending card with explicit action buttons). The one outlier, Notion
   Autofill, writes directly with no preview — and is also the one product
   whose own docs carry an explicit "always check the accuracy" disclaimer,
   which reads as an acknowledgment of that gap rather than a confident
   design choice.

## 3. References

- VS Code official docs — inline suggestions, Next Edit Suggestions,
  settings (`editor.inlineSuggest.*`), snooze commands:
  https://code.visualstudio.com/docs/copilot/ai-powered-suggestions
- GitHub official docs — automatic code review triggers, billing,
  comment/review semantics across the PR lifecycle:
  https://docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle
- Linear official docs — Triage Intelligence (triggers, workspace/team/
  property-level controls, accept/decline, guidance weighting):
  https://linear.app/docs/triage-intelligence
- Notion official help docs — Autofill (Basic vs. Custom Agent triggers,
  per-property enable, conditional instructions, accuracy caveat):
  https://www.notion.com/help/autofill
- Todoist official help center — "Introduction to Todoist Assist" (Filter
  Assist, Task Assist, Email Assist triggers and opt-in/opt-out controls):
  https://www.todoist.com/help/articles/introduction-to-todoist-assist-KgPP22q5O

## 4. Caveats

1. **GitHub Copilot Workspace's current status could not be verified**
   against an official GitHub source in this search — results conflicted,
   and none were from `github.com`/`docs.github.com`/`github.blog`
   directly. This survey substitutes two other officially-documented
   Copilot mechanisms (inline ghost-text suggestions, §2.1; automatic PR
   code review, §2.2) as the representative Copilot data points, since
   both are independently confirmed by GitHub/VS Code's own docs and both
   are relevant unprompted-suggestion mechanisms in their own right.
2. **Todoist's Task Assist browser-extension help page
   (`chrome.todoist.com/help/articles/6835695846300`) returned HTTP 503**
   during this research and could not be fetched directly; findings for
   Task Assist above rely only on the "Introduction to Todoist Assist"
   page's summary of it, which does not fully describe its trigger/UI
   shape. That page should be retried if a more complete picture of Task
   Assist specifically is needed.
3. **Neither GitHub's "substantial update" re-review threshold nor
   Linear's "strong semantic similarity" threshold is quantified** in the
   docs checked — both are acknowledged as a gate that exists, without the
   vendor publishing the mechanics behind it. Treat these as evidence that
   *some* significance/confidence floor is common practice, not as a
   reusable formula.
