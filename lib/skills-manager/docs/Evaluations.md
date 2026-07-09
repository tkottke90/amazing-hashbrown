# Evaluating Skills

The library supports two complementary evaluation workflows. Both operate on data only — running agent sessions and grading outputs happens in a caller-supplied eval runner built on top of these primitives.

---

## Output Quality Evals

Output quality evals test that a skill produces correct results for a given prompt. Test cases are stored in `evals/evals.json` inside the skill directory alongside any input fixtures they reference:

```
my-skills/
└── summarize/
    ├── SKILL.md
    └── evals/
        ├── evals.json        # test cases authored by the skill developer
        └── files/            # optional input fixtures referenced by test cases
            └── article.txt
```

A test case (`EvalCase`) has a prompt, an expected output description, optional input files, and optional assertions — verifiable statements about what the output must contain:

```json
{
  "skill_name": "summarize",
  "evals": [
    {
      "id": 1,
      "prompt": "Summarize the following article in bullet points.",
      "expected_output": "A 5–7 bullet summary of the article's key points.",
      "assertions": ["Each bullet is a single sentence", "No bullet exceeds 20 words"]
    },
    {
      "id": 2,
      "prompt": "Summarize the attached meeting transcript.",
      "expected_output": "A bullet-point list of action items from the meeting.",
      "files": ["meeting-notes.txt"],
      "assertions": ["Action items are listed first", "Each item names an owner"]
    }
  ]
}
```

Load and save eval suites with `loadEvals` / `saveEvals`:

```typescript
import { SkillsManager } from '@tkottke90/skills-manager';

const skills = new SkillsManager('/path/to/my-skills');
await skills.boot();

// Load existing test cases
const suite = await skills.loadEvals('summarize');

// Add a new case and save
suite.evals.push({
  id: 3,
  prompt: 'Give me the three most important takeaways from this report.',
  expected_output: 'Exactly three takeaways, each one sentence.',
  assertions: ['Exactly 3 items returned', 'Each item is one sentence'],
});
await skills.saveEvals('summarize', suite);
```

---

## Description Trigger Evals

Description trigger evals test whether a skill's `description` field reliably causes the agent to invoke the skill for appropriate queries — and to _not_ invoke it for unrelated ones. They are used to tune the description wording systematically.

Each entry is a query labeled with whether the skill should trigger:

```typescript
import { splitEvalQueries } from '@tkottke90/skills-manager';
import type { EvalQuery } from '@tkottke90/skills-manager';

const queries: EvalQuery[] = [
  { query: 'Can you summarize this article?', should_trigger: true },
  { query: 'Summarize the key points from this document.', should_trigger: true },
  { query: 'Translate this paragraph to French.', should_trigger: false },
  { query: 'What is the capital of France?', should_trigger: false },
  // ...
];

// Split into train (60%) and validation (40%) sets.
// The split is deterministic — same input always produces the same split,
// which is important when iterating on the description across multiple runs.
const { train, validation } = splitEvalQueries(queries, 0.6);
```

The split preserves the `should_trigger` ratio across both sets so neither is skewed.

### The `largeDesc` signal

A skill summary carries a `largeDesc` flag when its description exceeds 1024 characters:

```typescript
const all = skills.list();
const flagged = all.filter((s) => s.largeDesc);
// Descriptions above 1024 chars may degrade trigger reliability —
// a good candidate for description trigger evals.
```

No error is thrown for large descriptions — `largeDesc: true` is the signal for callers (UI, notifications, middleware) to surface a warning and prioritize description trigger evals for that skill.

---

## How an Eval Runner Uses This Data

The library provides data and types; the runner provides execution. Here is the conceptual loop an eval runner builds on top:

```typescript
import { SkillsManager, aggregateBenchmark } from '@tkottke90/skills-manager';
import type { GradingResult, TimingData } from '@tkottke90/skills-manager';

const skills = new SkillsManager('/path/to/my-skills');
await skills.boot();

// 1. Load the test cases the skill author wrote
const suite = await skills.loadEvals('summarize');

// 2. (Runner's responsibility) Execute each case against the agent — once with
//    the skill injected into the system prompt, once without — and collect
//    GradingResult and TimingData for each run.
const withSkillResults: GradingResult[] = /* ... */;
const withSkillTimings: TimingData[] = /* ... */;
const withoutSkillResults: GradingResult[] = /* ... */;
const withoutSkillTimings: TimingData[] = /* ... */;

// 3. Aggregate into benchmark stats
const withStats = aggregateBenchmark(withSkillResults, withSkillTimings);
const withoutStats = aggregateBenchmark(withoutSkillResults, withoutSkillTimings);

// 4. Compute deltas and write benchmark.json to the eval workspace
const benchmark = {
  run_summary: {
    with_skill: withStats,
    without_skill: withoutStats,
    delta: {
      pass_rate: withStats.pass_rate.mean - withoutStats.pass_rate.mean,
      time_seconds: withStats.time_seconds.mean - withoutStats.time_seconds.mean,
      tokens: withStats.tokens.mean - withoutStats.tokens.mean,
    },
  },
};
```

`GradingResult`, `TimingData`, `BenchmarkResult`, and `RunStats` are all exported from the library so the runner and any reporting tools share a common schema.

---

## Further Reading

- [Using PromptFoo with the Skills Eval System](./eval-promptfoo-example.md) — how to wire `skills-manager` eval data to PromptFoo for execution, grading, and the side-by-side UI.
