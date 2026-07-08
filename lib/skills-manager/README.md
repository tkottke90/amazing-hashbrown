# @tkottke90/skills-manager

`@tkottke90/skills-manager` manages a directory of skills on disk. A skill is a self-contained unit — a folder with a `SKILL.md` file — that the manager can discover, load, and execute on behalf of an agent.

At startup the manager scans the skills root and builds a lightweight in-memory index of skill names and descriptions. From there it loads full skill content on demand for injection into an LLM context, and provides CRUD operations for creating and editing skills at runtime.

Skills can optionally include runnable scripts (JavaScript or Python). The manager executes these in isolation: JS scripts run inside a sandboxed Node.js VM; Python scripts run via a per-skill virtual environment, `uv`, or the system `python3` interpreter — whichever is available.

---

## Skill Directory Layout

```
my-skills/
└── pdf-processing/
    ├── SKILL.md          # required — name, description, instructions
    ├── scripts/
    │   └── extract.js    # optional runnable scripts
    └── references/
        └── schema.json   # optional reference files the skill uses
```

`SKILL.md` has a YAML front section (name, description, and optional fields) followed by free-form Markdown instructions. The instructions are what gets injected into the agent's context.

```yaml
---
name: pdf-processing
description: Extracts structured data from PDF files.
---

When the user provides a PDF, call the extract script to pull out the raw text,
then summarize the key sections...
```

---

## Getting Started

### Step 1 — Install

```bash
npm install @tkottke90/skills-manager
```

### Step 2 — Create your first skill

```
my-skills/
└── summarize/
    └── SKILL.md
```

`SKILL.md`:

```
---
name: summarize
description: Summarizes a document into bullet points.
---

When the user asks you to summarize something, produce a concise bullet-point list.
Keep bullets to one sentence each. Aim for 5–7 bullets unless the source is very short.
```

### Step 3 — Instantiate and boot

```typescript
import { SkillsManager } from '@tkottke90/skills-manager';

const skills = new SkillsManager('/path/to/my-skills');
await skills.boot(); // scans disk, builds index
```

### Step 4 — List available skills

```typescript
const all = skills.list();
// [{ name: 'summarize', description: 'Summarizes a document...', slashCommand: '/summarize', enabled: true }]
```

### Step 5 — Inject a skill into your agent

```typescript
const instructions = await skills.lookup('summarize');
// Pass `instructions` as part of your system prompt or user message to the LLM.
```

### Step 6 — Create a skill at runtime

```typescript
const newSkill = await skills.create({
  name: 'translate',
  description: 'Translates text between languages.',
  body: 'When translating, preserve tone and formatting. ...',
});
```

### Step 7 — Run a script (optional)

```typescript
// JS script — runs in a sandboxed Node VM
const result = await skills.runScript('pdf-processing', 'extract.js', { filePath: '/tmp/doc.pdf' });

// Python script — resolves .venv → uv → python3
const { stdout, exitCode } = await skills.runPythonScript('pdf-processing', 'extract.py', ['--input', '/tmp/doc.pdf']);
```

---

## Working with Asset Files

Use `readFile` / `writeFile` / `deleteFile` to inspect and manage the scripts and reference files belonging to a skill — for example, from a skill management UI:

```typescript
// Read a script's source
const src = await skills.readFile('pdf-processing', 'scripts', 'extract.js');

// Save an edited version back
await skills.writeFile('pdf-processing', 'scripts', 'extract.js', updatedSrc);

// Add a new reference file
await skills.writeFile('pdf-processing', 'references', 'schema.json', JSON.stringify(schema));

// Remove a file you no longer need
await skills.deleteFile('pdf-processing', 'references', 'old-schema.json');
```

`load()` returns an inventory of which files exist (basenames + absolute paths). `readFile` fetches the content of any one of them on demand, so the inventory call stays lightweight.

---

## Disabling a Skill

Set `enabled: false` via `edit()` to hide a skill from `list()` results without deleting it:

```typescript
await skills.edit('summarize', { enabled: false });
```

Re-enable it later with `{ enabled: true }`.

---

## Python Script Isolation

When running Python scripts, the manager resolves the interpreter via a three-step chain:

1. **Per-skill `.venv`** — if `<skill>/.venv/bin/python` exists, use it. The skill author creates this venv and installs any required packages. Provides full, pinned dependency isolation.
2. **`uv run`** — if `uv` is on the system PATH, use `uv run <script>`. Supports [PEP 723](https://peps.python.org/pep-0723/) inline dependency declarations inside the script file itself. Dependencies are cached and reused automatically.
3. **`python3`** — bare fallback for scripts that only use the standard library.

The manager never creates or manages virtual environments itself.

---

## Evaluating Skills

The library supports two complementary evaluation workflows. Both operate on data only — running agent sessions and grading outputs happens in a caller-supplied eval runner built on top of these primitives.

### Output quality evals

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
      "assertions": [
        "Each bullet is a single sentence",
        "No bullet exceeds 20 words"
      ]
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

### Description trigger evals

Description trigger evals test whether a skill's `description` field reliably causes the agent to invoke the skill for appropriate queries — and to *not* invoke it for unrelated ones. They are used to tune the description wording systematically.

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

A skill summary carries a `largeDesc` flag when its description exceeds 1024 characters:

```typescript
const all = skills.list();
const flagged = all.filter((s) => s.largeDesc);
// Descriptions above 1024 chars may degrade trigger reliability —
// a good candidate for description trigger evals.
```

### How an eval runner uses this data

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
