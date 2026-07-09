# Using PromptFoo with the Skills Eval System

[PromptFoo](https://www.promptfoo.dev/docs/intro/) is an open-source LLM evaluation framework that handles test execution, LLM provider management, and result reporting. It complements `@tkottke90/skills-manager` well: the library owns the test case data and types; PromptFoo owns the execution, grading, and output.

This guide shows how to wire them together.

---

## How They Fit Together

| Layer | Responsibility |
|---|---|
| `skills-manager` | Stores and loads `evals/evals.json`; provides `EvalCase`, `GradingResult`, `aggregateBenchmark` types |
| PromptFoo | Runs each test case against an LLM provider, grades assertions, produces structured results |
| Adapter (your code) | Converts `EvalSuite` → PromptFoo config; maps PromptFoo results → `GradingResult[]` |

The key design decision: PromptFoo is the **runner**, not the source of truth. Test cases stay in `evals/evals.json` and are loaded via `loadEvals()`. The adapter layer is thin — no business logic, just format translation.

---

## Setup

Install PromptFoo alongside the skills manager:

```bash
npm install --save-dev promptfoo
```

---

## The With-Skill vs. Without-Skill Comparison

The core skill eval question is: does injecting the skill's instructions into the system prompt actually improve output quality? PromptFoo models this as two providers running the same test cases in parallel.

```typescript
// adapter/run-evals.ts
import { SkillsManager } from '@tkottke90/skills-manager';
import { evaluate } from 'promptfoo';
import type { EvalSuite, GradingResult } from '@tkottke90/skills-manager';

async function runSkillEval(skillName: string, skillsRoot: string) {
  const skills = new SkillsManager(skillsRoot);
  await skills.boot();

  // Load the skill's instructions and test cases
  const instructions = await skills.lookup(skillName);
  const suite = await skills.loadEvals(skillName);

  const config = buildPromptFooConfig(suite, instructions);
  const results = await evaluate(config, { verbose: false });

  return results;
}
```

---

## Building the PromptFoo Config

Convert an `EvalSuite` into a PromptFoo configuration. The key moves are:

- **Two providers**: one injects the skill as a system prompt, one doesn't
- **Assertions**: map our free-text `assertions: string[]` to PromptFoo's `llm-rubric` type, which asks an LLM to judge whether each assertion holds
- **Files**: load fixture files from `evals/files/` and pass them as variables

```typescript
import type { EvalSuite } from '@tkottke90/skills-manager';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function buildPromptFooConfig(suite: EvalSuite, skillInstructions: string, skillsRoot: string) {
  return {
    providers: [
      {
        id: 'with-skill',
        config: {
          // The skill's SKILL.md body injected as the system prompt
          systemPrompt: skillInstructions,
        },
      },
      {
        id: 'without-skill',
        // No system prompt — baseline comparison
      },
    ],

    prompts: ['{{prompt}}'],

    tests: suite.evals.map((evalCase) => {
      // Load any referenced fixture files and pass as vars
      const fileContents: Record<string, string> = {};
      for (const filePath of evalCase.files ?? []) {
        const key = filePath.replace(/[^a-z0-9]/gi, '_');
        fileContents[key] = readFileSync(
          join(skillsRoot, suite.skill_name, 'evals', 'files', filePath),
          'utf8',
        );
      }

      return {
        vars: {
          prompt: evalCase.prompt,
          expected: evalCase.expected_output,
          ...fileContents,
        },
        assert: [
          // Always check against the expected output description
          {
            type: 'llm-rubric',
            value: `The output matches this description: ${evalCase.expected_output}`,
          },
          // Map each free-text assertion to an llm-rubric check
          ...(evalCase.assertions ?? []).map((assertion) => ({
            type: 'llm-rubric' as const,
            value: assertion,
          })),
        ],
        // Carry the original eval case ID through for result mapping
        metadata: { evalId: evalCase.id },
      };
    }),
  };
}
```

---

## Mapping PromptFoo Results to `GradingResult`

After PromptFoo runs, convert its output to the `GradingResult[]` shape used by `aggregateBenchmark()`:

```typescript
import type { GradingResult, AssertionResult } from '@tkottke90/skills-manager';

function toGradingResults(promptFooResults: any): {
  withSkill: GradingResult[];
  withoutSkill: GradingResult[];
} {
  const withSkill: GradingResult[] = [];
  const withoutSkill: GradingResult[] = [];

  for (const result of promptFooResults.results) {
    const assertionResults: AssertionResult[] = result.gradingResult?.componentResults?.map(
      (r: any) => ({
        text: r.assertion?.value ?? '',
        passed: r.pass,
        evidence: r.reason ?? '',
      }),
    ) ?? [];

    const passed = assertionResults.filter((a) => a.passed).length;
    const total = assertionResults.length;

    const gradingResult: GradingResult = {
      assertion_results: assertionResults,
      summary: {
        passed,
        failed: total - passed,
        total,
        pass_rate: total > 0 ? passed / total : 0,
      },
    };

    if (result.provider?.id === 'with-skill') {
      withSkill.push(gradingResult);
    } else {
      withoutSkill.push(gradingResult);
    }
  }

  return { withSkill, withoutSkill };
}
```

---

## Full Example: Run and Benchmark

Putting it all together — run the eval and produce a `BenchmarkResult`:

```typescript
import { SkillsManager, aggregateBenchmark } from '@tkottke90/skills-manager';
import type { BenchmarkResult } from '@tkottke90/skills-manager';
import { evaluate } from 'promptfoo';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function benchmarkSkill(
  skillName: string,
  skillsRoot: string,
  workspaceDir: string,
): Promise<BenchmarkResult> {
  const skills = new SkillsManager(skillsRoot);
  await skills.boot();

  const instructions = await skills.lookup(skillName);
  const suite = await skills.loadEvals(skillName);

  const config = buildPromptFooConfig(suite, instructions, skillsRoot);
  const promptFooResults = await evaluate(config, { verbose: false });

  const { withSkill, withoutSkill } = toGradingResults(promptFooResults);

  const withStats = aggregateBenchmark(withSkill);
  const withoutStats = aggregateBenchmark(withoutSkill);

  const benchmark: BenchmarkResult = {
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

  // Write benchmark.json to the eval workspace
  writeFileSync(join(workspaceDir, 'benchmark.json'), JSON.stringify(benchmark, null, 2), 'utf8');

  return benchmark;
}
```

---

## Assertion Format: Free-Text vs. PromptFoo Types

Our `assertions: string[]` are plain English statements graded by an LLM. PromptFoo's `llm-rubric` type is the right match — it sends each statement to an LLM judge and gets a pass/fail with a reason.

If you find you want deterministic (non-LLM) checks alongside the rubric assertions, PromptFoo supports mixing types in the same test case:

```typescript
assert: [
  // LLM-graded
  { type: 'llm-rubric', value: 'The response is written in a professional tone' },
  // Deterministic — no LLM call
  { type: 'not-contains', value: 'I cannot help with that' },
  { type: 'javascript', value: 'output.split("\\n").length <= 10' },
]
```

To use mixed assertion types, you would extend `EvalCase.assertions` to support a structured form (e.g. `{ type: string; value: string }[]`) rather than plain strings. The `EvalCase` type in `types.ts` would need updating if you go this route.

---

## Running PromptFoo's Built-in UI

PromptFoo ships a web UI for exploring results side by side. After running an eval:

```bash
npx promptfoo view
```

This gives you a table of every test case, the with-skill vs. without-skill outputs, and which assertions passed or failed — useful for diagnosing which cases the skill helps most (and least).
