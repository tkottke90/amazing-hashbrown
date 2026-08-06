# Interpreting eval results — lessons from doing this by hand

Everything below was learned the hard way, over several rounds of manually
running `wiki-navigation` against `ornith` and `glm` and reading the raw
results. Read this before diagnosing a failure or writing a fix — it'll save
you from repeating mistakes that already happened once.

## 1. Read `calledTools`, not just `toolCalled`

Every `tool-call`/`tool-sequence` scenario result has two fields:

- `toolCalled`: the matched tool name, or `null` if nothing matched what the
  scenario expected.
- `calledTools`: every tool name actually invoked this turn, matched or not.

`toolCalled: null` on its own is ambiguous — it covers both "the model called
a completely different tool" and "the model called no tool at all." Always
check `calledTools` before concluding anything:

- `calledTools: ["wiki_search"]` with `toolCalled: null` and an expected tool
  of `wiki_orient` → the model chose the wrong tool. Read `reasoningContent`
  to find out why (usually it's a real, fixable reasoning gap).
- `calledTools: []` with `toolCalled: null`, empty `actualOutput`, and
  `finish_reason: "tool_calls"` → this is the one shape that's genuinely
  ambiguous from the YAML alone (see §6, DEBUG_LLM_HTTP).
- `calledTools: []` with `toolCalled: null` and real prose in `actualOutput`,
  `finish_reason: "stop"` → the model deliberately answered in text instead
  of calling any tool. That's a real behavior to fix or a real model
  limitation (see §5), not an extraction bug.

This field didn't always exist — a "wrong tool called" was indistinguishable
from "no tool called" until it was added specifically because a previous
round's diagnosis (wrongly) blamed a serving-side bug for what turned out to
be an ordinary wrong-tool-call. If a future change to the eval harness ever
removes or renames this field, the ambiguity comes back — don't let that
happen silently.

## 2. A failing scenario isn't always a real bug — check the scenario itself first

If `calledTools` shows the _right_ tool was called but an `argCheck` still
failed, don't assume the model did something wrong. Check the tool's own zod
schema (`api/src/agents/tools/*.tool.ts`) for the argument in question. If
it's documented as optional with a legitimate alternate mode — e.g.
`wiki_locate`'s `context` param, whose own description says "Omit to browse
all registered domains" — then a model that calls it argless in a
browse-appropriate situation is following the tool's contract correctly. The
scenario's `argChecks` requiring that arg to exist is then the bug, not the
prompt or the model.

This exact situation has happened twice (`wnav-006`, then `wnav-001`) and
both times the fix was to loosen the scenario's `argChecks` in
`suites/wiki-navigation.yaml`, not touch `api/src/agents/system-prompt.ts`.
When you hit this, add a comment on the scenario explaining why, the same
way those two scenarios already document it — so the next round doesn't
"fix" it back into a stricter check.

## 3. Contrastive examples anchor better than abstract rules

When a prompt section states a rule abstractly ("skip this step when X"), a
smaller/quantized model can apply it inconsistently — it knows the rule
exists but doesn't reliably recognize when it fires. A worked example pair
("do this for input A, don't do it for input B") anchors far better than
restating the rule more emphatically. `api/src/agents/system-prompt.ts`'s
`WIKI_NAVIGATION_SECTION` demonstrates this pattern directly — read its
current contrastive examples before adding a new one, and prefer extending
an existing example over writing a new abstract sentence.

**Watch for over-generalization.** A contrastive example anchors on its
_specific wording_, and a model can pattern-match the surface phrasing onto
inputs that only superficially resemble it. This has happened concretely:
an example using "favorite color" as a stand-in for "obviously the user's
own domain" got over-applied to a genuinely different question ("which part
of the knowledge base should I check?") that merely mentioned "personal
preferences." When a fix for one scenario causes a _different_,
previously-passing scenario to regress in the same direction, that's usually
this — the cure is a second, narrower contrastive example distinguishing the
two cases, not reverting the first fix.

**Watch for phrasing sensitivity within the same example.** An example
anchored to one exact phrasing may not transfer to a semantically identical
but cosmetically different input. This happened with "Verdaccio" (bare noun
phrase, fixed) vs. "my Verdaccio instance" (possessive, still failed) — same
topic, same intended rule, different surface form. When you see this, extend
the _same_ example to explicitly cover the missed phrasing rather than
writing a third, separate example for what's really one lesson.

## 4. Document every change the same way this file's neighbor does

`api/src/agents/system-prompt.ts` keeps a running header comment above each
section, numbering each wording change ("tightening") with: what eval
evidence motivated it, exactly what changed, and what to check on the next
run. Keep using this convention — append the next-numbered entry, don't
rewrite earlier ones (even to correct them; if an earlier entry's conclusion
turned out wrong, say so in the new entry rather than editing history out
from under it — this already happened once with a premature "serving-side
bug" conclusion that a later round corrected in-place with a visible note).

Whenever you touch `WIKI_NAVIGATION_SECTION`, `MEMORY_SECTION`, or any other
exported section constant, also add or extend a matching assertion in
`api/src/agents/system-prompt.test.ts`. Because these are template literals
with real line breaks baked into the source (not auto-wrapped), a test
string has to match the _actual_ wrapped text exactly, whitespace and all.
Since this environment usually can't run `npm test` directly (no
`node_modules`, no network to install), verify a new assertion string
matches before committing to it, using something like:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("api/src/agents/system-prompt.ts", "utf8");
const start = src.indexOf("const WIKI_NAVIGATION_SECTION = `") + "const WIKI_NAVIGATION_SECTION = `".length;
const end = src.indexOf("`;", start);
const section = src.slice(start, end);
console.log(section.includes("your new substring here"));
'
```

If you _do_ have a working `npm test`/`npm run build` in your environment,
prefer running those for real over this manual check — this is a fallback,
not a replacement.

## 5. Recognize a capability ceiling instead of chasing it

Some failures are not prompt problems. The signature to watch for: the same
scenario keeps failing, in the same shape, across multiple rounds — even
after a round specifically targeted it with a concrete, mechanical rule (not
just a restated abstraction). Two forms this has taken in practice:

- The model's own `reasoningContent` **states the correct rule** ("I should
  call wiki_locate first") and then **doesn't follow through** (calls a
  different tool anyway).
- The model **misremembers its own inputs** — e.g. treating a `wiki_locate`
  result that named two candidate domains as if it had only ever named one,
  even when told explicitly and concretely to check for exactly that.

If you see either shape recur on the _same scenario_ in two consecutive
rounds where a round in between specifically added wording for it, stop
iterating on that scenario. Say so plainly in the log entry (don't just mark
it "still failing" — note that it looks like a model capability limit, not a
wording gap) and move on to other real failures. Burning more rounds on it
won't help, and it's exactly the kind of thing the loop's plateau detection
(see SKILL.md) exists to catch.

A useful cross-check: if one configured model passes a scenario reliably
and another fails it repeatedly with wording unchanged between runs, that's
evidence the gap is in that specific model's capability, not universal to
the prompt — don't over-rotate the prompt trying to drag a weaker model
across a line a stronger one already clears, since edits aimed at the
weaker model's specific miss can just as easily degrade the stronger one.

## 6. When DEBUG_LLM_HTTP is actually worth it

`api/src/services/provider-factory.ts` has a `DEBUG_LLM_HTTP=1` env var that
logs the _raw_, pre-parse HTTP response body from the model server. It was
originally added to answer one question: was a `toolCalled: null` result a
genuinely empty response, or a bug swallowing a real tool call? The
`calledTools` field (§1) now answers that question directly for most cases,
so reach for `DEBUG_LLM_HTTP` less often than you might expect — mainly when
a result is _still_ unexplained after reading `calledTools`,
`invalidToolCalls`, `responseMetadata`, and `reasoningContent` together. The
one shape that still warrants it: `calledTools: []`, empty `actualOutput`,
and `finish_reason: "tool_calls"` all at once — that combination says the
server itself may be misreporting what it did, and only the raw wire log can
confirm it.

Don't turn it on by default "just in case" — it adds console noise and a
combined log file per model per round for no benefit when the YAML result
already explains what happened.
