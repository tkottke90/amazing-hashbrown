#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import {
  executeScenario,
  loadSuite,
  formatStreamTrace,
  summarizeStreamTrace,
  toTraceChunks,
  type SkillExpansionMiddlewareLike,
  type SkillGatedToolsMiddlewareLike,
  type StreamedChunkLike,
  type TraceChunk,
} from '../lib/evaluations/src/index.js';
import {
  applyEvalDeterminism,
  createProviderFromConfig,
  describeSampling,
  resolveProviderConfig,
} from '../api/src/services/provider-factory.js';
import { createSkillExpansionMiddleware } from '../api/src/agents/skill-expansion.middleware.js';
import { createSkillGatedToolsMiddleware } from '../api/src/agents/skill-gated-tools.middleware.js';
import { GATED_SKILL_REGISTRATIONS } from '../api/src/agents/gated-skill-registrations.js';
import { bootSkillsManager } from '../api/src/services/skills-manager.js';
import { filterHarnessSections } from '../api/src/agents/system-prompt.js';
import { extractRequestedToolIds, buildRequiredToolBlocks } from '../api/src/agents/tool-syntax.js';
import { evalTools, buildEvalSystemPrompt } from './eval-setup.js';

// Diagnostic, not a scored eval. Runs ONE scenario through the real
// executeScenario path — same tools, system prompt, seeded turns and sampling
// pins as `npm run eval` — but with the model's call streamed instead of
// awaited, so when Ollama aborts a generation ("prediction aborted, token
// repeat limit reached") the text the model had produced up to that point is
// printed instead of discarded. See docs/App-Docs/Evaluations.md.
//
// Usage:
//   npm run eval:trace -- --suite wiki-navigation-heldout \
//     --scenario wnavh-003-read-page-indirect-phrasing --model local
//
// Exit codes: 0 no run errored mid-stream, 1 at least one run errored, 2 usage
// error, 3 setup/runtime error.

const DEFAULT_EVAL_SEED = 42;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    scenario: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    seed: { type: 'string' },
    temperature: { type: 'string' },
    runs: { type: 'string', default: '1' },
    tail: { type: 'string', default: '25' },
    verbose: { type: 'boolean', default: false },
  },
  strict: false,
});

function usageError(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

if (!values.suite) usageError('--suite <id> is required');
if (!values.scenario) usageError('--scenario <id> is required');
if (!values.model) usageError('--model <name> is required');
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) usageError('--runs must be an integer >= 1');
const tailLines = Number(values.tail);
if (!Number.isInteger(tailLines) || tailLines < 1) usageError('--tail must be an integer >= 1');
const seed = values.seed === undefined ? DEFAULT_EVAL_SEED : Number(values.seed);
if (!Number.isFinite(seed)) usageError('--seed must be a number');
const temperature = values.temperature === undefined ? undefined : Number(values.temperature);
if (temperature !== undefined && !Number.isFinite(temperature)) {
  usageError('--temperature must be a number');
}

const suiteId = String(values.suite);
const scenarioId = String(values.scenario);
const modelId = String(values.model);

// One entry per model call a scenario makes. Most scenarios make exactly one;
// recording each keeps a multi-call scenario's earlier calls from being
// overwritten by the call that failed.
interface RecordedCall {
  chunks: TraceChunk[];
  error?: string;
}

// Wraps a chat model so `.bindTools(tools).invoke(input)` — the one call
// invokeToolCallModel in lib/evaluations/src/runner.ts makes — streams
// instead, recording every chunk as it arrives and re-throwing any error
// unchanged so the scenario fails exactly as it would in the eval. Everything
// else on the model is passed straight through.
function withStreamTrace(model: BaseChatModel, calls: RecordedCall[]): BaseChatModel {
  return new Proxy(model, {
    get(target, prop) {
      if (prop === 'bindTools') {
        return (...args: Parameters<NonNullable<BaseChatModel['bindTools']>>) => {
          const bound = target.bindTools!(...args);
          return {
            invoke: async (input: string | BaseMessage[], options?: Record<string, unknown>) => {
              const call: RecordedCall = { chunks: [] };
              calls.push(call);
              let accumulated: Awaited<ReturnType<typeof bound.invoke>> | undefined;
              try {
                const stream = await bound.stream(input, options);
                for await (const chunk of stream) {
                  call.chunks.push(...toTraceChunks(chunk as StreamedChunkLike));
                  accumulated = accumulated ? accumulated.concat(chunk) : chunk;
                }
              } catch (err) {
                call.error = err instanceof Error ? err.message : String(err);
                throw err;
              }
              if (!accumulated) throw new Error('the model streamed no chunks');
              return accumulated;
            },
          };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BaseChatModel;
}

// A trace run has no scoring to do, so a judge is only needed when the chosen
// scenario has a rubric. Rather than silently reusing the model under test
// (the eval deliberately has no same-model fallback), fail loudly if one is
// touched without --judge-model.
const judgeUnavailable = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      throw new Error('this scenario needs a judge model — pass --judge-model <name>');
    },
  },
) as BaseChatModel;

let model: BaseChatModel;
let judgeModel: BaseChatModel = judgeUnavailable;
const judgeModelId = values['judge-model'] ? String(values['judge-model']) : 'none';
try {
  const modelConfig = applyEvalDeterminism(resolveProviderConfig(modelId), seed, { temperature });
  model = createProviderFromConfig(modelConfig);
  console.log(`[trace] sampling — model "${modelId}": ${describeSampling(modelConfig)}`);
  if (values['judge-model']) {
    judgeModel = createProviderFromConfig(
      applyEvalDeterminism(resolveProviderConfig(judgeModelId), seed),
    );
  }
} catch (err) {
  console.error(`Error creating model: ${String(err)}`);
  process.exit(3);
}

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const suitesPath = resolve(projectRoot, 'suites');

const suite = await loadSuite(suiteId, { bundledPath: suitesPath });
if (!suite) usageError(`suite "${suiteId}" not found in ${suitesPath}`);
const scenario = suite.scenarios.find((s) => s.id === scenarioId);
if (!scenario) {
  usageError(
    `scenario "${scenarioId}" not found in suite "${suiteId}". Available:\n  ` +
      suite.scenarios.map((s) => s.id).join('\n  '),
  );
}
if (scenario.type !== 'tool-call' && scenario.type !== 'tool-sequence') {
  console.warn(
    `[trace] warning: "${scenarioId}" is a ${scenario.type} scenario — only tool-call and ` +
      'tool-sequence scenarios go through the bindTools path this script streams, so ' +
      'nothing may be traced.',
  );
}

await bootSkillsManager();
const skillExpansionMiddleware = createSkillExpansionMiddleware(GATED_SKILL_REGISTRATIONS);
const skillGatedToolsMiddleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);

const logDir = resolve(
  projectRoot,
  'eval-logs',
  `stream-trace-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(logDir, { recursive: true });

let anyStreamError = false;
for (let n = 1; n <= runs; n++) {
  const calls: RecordedCall[] = [];
  const result = await executeScenario(
    scenario,
    suite,
    crypto.randomUUID(),
    {
      suiteId,
      model: withStreamTrace(model, calls),
      modelId,
      judgeModel,
      judgeModelId,
      tools: evalTools,
      systemPrompt: buildEvalSystemPrompt(suite),
      filterHarnessSections,
      extractRequestedToolIds,
      buildRequiredToolBlocks,
      suitePaths: { bundledPath: suitesPath },
      resultPath: resolve(projectRoot, 'eval-results'),
      ci: true,
      noHtml: true,
      skillExpansionMiddleware: skillExpansionMiddleware as unknown as SkillExpansionMiddlewareLike,
      skillGatedToolsMiddleware:
        skillGatedToolsMiddleware as unknown as SkillGatedToolsMiddlewareLike,
    },
    { count: 0, total: 0 },
  );

  console.log(`\n=== run ${n}/${runs} — ${scenarioId} (${modelId}) ===`);
  console.log(`Scenario ${result.passed ? 'PASSED' : 'FAILED'}`);
  const preview = result.actualOutput.replace(/\s+/g, ' ').slice(0, 300);
  if (preview) console.log(`Output: ${preview}`);

  if (calls.length === 0) {
    console.log('No model call was streamed (see the warning above if the type is not tool-call).');
  }
  calls.forEach((call, i) => {
    const label = calls.length > 1 ? `call ${i + 1}/${calls.length}` : 'model call';
    const summary = summarizeStreamTrace(call.chunks);
    if (call.error) {
      anyStreamError = true;
      console.log(`\n✗ ${label} errored mid-stream: ${call.error}`);
      console.log(formatStreamTrace(call.chunks, { tailLines }));
      if (call.chunks.length === 0) {
        console.log(
          '\nNothing was streamed before the abort, so the repeating text is not visible from ' +
            'the client: Ollama counts repeats on the raw token stream, upstream of the parser that ' +
            'decides what to send (it holds back tool-call bodies until the call completes). To ' +
            'see the raw tokens, restart Ollama with OLLAMA_DEBUG=2 and read the ' +
            '"builtin parser input" lines at the end of its log — see docs/App-Docs/Evaluations.md.',
        );
      }
    } else if (values.verbose) {
      console.log(`\n${label} completed:`);
      console.log(formatStreamTrace(call.chunks, { tailLines }));
    } else {
      const run = summary.longestRun;
      console.log(
        `${label} completed — ${summary.totalChunks} chunks` +
          (run ? `, longest repeat ${run.length} ("${run.channel}")` : '') +
          ' (pass --verbose to print the stream)',
      );
    }
  });

  const logPath = resolve(logDir, `run-${n}.json`);
  writeFileSync(
    logPath,
    JSON.stringify(
      {
        suiteId,
        scenarioId,
        modelId,
        seed,
        temperature: temperature ?? null,
        passed: result.passed,
        actualOutput: result.actualOutput,
        calls: calls.map((call) => ({
          error: call.error ?? null,
          summary: summarizeStreamTrace(call.chunks),
          chunks: call.chunks,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`Full chunk log: ${logPath}`);
}

if (!anyStreamError) {
  console.log(
    '\nNo run errored mid-stream. If `npm run eval` still aborts on this scenario, streaming ' +
      'changed the behaviour (the non-streaming path hit the abort, this one did not) — report ' +
      'that; it is a finding in itself.',
  );
}
process.exit(anyStreamError ? 1 : 0);
