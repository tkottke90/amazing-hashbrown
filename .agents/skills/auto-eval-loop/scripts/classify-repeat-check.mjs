#!/usr/bin/env node
// Classifies a round's failed scenarios as real, noise, or inconclusive
// from a `npm run eval:probe` run's probe.json — so the calling agent never
// has to parse probe.json itself and risk mis-reading a nested outcomes
// array. The repeat-failure safeguard (SKILL.md steps 5a/5b) hands this
// script the probe.json path and the scenario IDs that failed this round;
// everything here is a pure read + classify, no process spawning.
//
// Usage:
//   node classify-repeat-check.mjs \
//     --probe-json <path to probe.json> \
//     --suite <suite-id> \
//     --model <model-name> \
//     --scenario-ids <comma-separated scenario IDs>
//
// Output (stdout), nothing else:
//   On an analyzed probe entry, one line per requested scenario:
//     scenario_id=<id> outcomes=<o1,o2,o3> fail_count=<n> verdict=<real|noise|inconclusive>
//   On an errored probe entry (the whole suite/model run aborted), instead:
//     probe_status=errored
//     probe_reason=<the ProbeEntry's reason string>
//     scenario_id=<id> verdict=inconclusive   (one per requested scenario)
//   Always last:
//     probe_json=<path, echoed exactly as given>
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Pure outcome-array -> verdict. Any error/missing outcome always wins
// (fail-safe) — a scenario the harness itself couldn't cleanly run in every
// attempt is never confidently called noise.
export function classifyScenario(outcomes) {
  if (outcomes.some((o) => o === 'error' || o === 'missing')) return 'inconclusive';
  const failCount = outcomes.filter((o) => o === 'fail').length;
  return failCount >= 2 ? 'real' : 'noise';
}

// Locates the ProbeEntry for (suiteId, model) in a loaded probe.json.
// Throws a descriptive Error (no process.exit — callers decide how to
// report it) if none matches.
export function findProbeEntry(probeJson, { suiteId, model }) {
  const entry = (probeJson.entries ?? []).find(
    (e) => e.suiteId === suiteId && e.model === model,
  );
  if (!entry) {
    throw new Error(`no probe entry found for suite "${suiteId}" / model "${model}" in probe.json`);
  }
  return entry;
}

// Given one ProbeEntry and the scenario IDs the caller asked to check,
// returns one classification per scenario ID. An `errored` whole-entry
// status short-circuits every scenario to `inconclusive` (there is no
// per-scenario data to classify). An `analyzed` entry looks each scenario
// ID up among `entry.analysis.scenarios`, throwing a descriptive error
// naming the available scenario IDs if one isn't found there.
export function classifyRepeatCheck(entry, scenarioIds) {
  if (entry.status === 'errored') {
    return scenarioIds.map((scenarioId) => ({ scenarioId, verdict: 'inconclusive' }));
  }
  return scenarioIds.map((scenarioId) => {
    const scenario = entry.analysis.scenarios.find((s) => s.scenarioId === scenarioId);
    if (!scenario) {
      const available = entry.analysis.scenarios.map((s) => s.scenarioId).join(', ') || '(none)';
      throw new Error(
        `scenario "${scenarioId}" not found among probe's scored scenarios for ${entry.model}/${entry.suiteId} (available: ${available})`,
      );
    }
    const failCount = scenario.outcomes.filter((o) => o === 'fail').length;
    return {
      scenarioId,
      outcomes: scenario.outcomes,
      failCount,
      verdict: classifyScenario(scenario.outcomes),
    };
  });
}

function parseScenarioIds(raw) {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error('--scenario-ids is required and must contain at least one scenario ID');
  }
  return ids;
}

function main() {
  const { values: args } = parseArgs({
    options: {
      'probe-json': { type: 'string' },
      suite: { type: 'string' },
      model: { type: 'string' },
      'scenario-ids': { type: 'string' },
    },
  });

  const required = ['probe-json', 'suite', 'model', 'scenario-ids'];
  const missing = required.filter((key) => args[key] === undefined || args[key] === '');
  if (missing.length > 0) {
    console.error(`classify-repeat-check.mjs: missing required --${missing.join(', --')}`);
    process.exit(1);
  }

  let scenarioIds;
  try {
    scenarioIds = parseScenarioIds(args['scenario-ids']);
  } catch (err) {
    console.error(`classify-repeat-check.mjs: ${err.message}`);
    process.exit(1);
  }

  let probeJson;
  try {
    probeJson = JSON.parse(readFileSync(args['probe-json'], 'utf8'));
  } catch (err) {
    console.error(`classify-repeat-check.mjs: could not read/parse ${args['probe-json']}: ${err.message}`);
    process.exit(1);
  }

  let entry;
  let results;
  try {
    entry = findProbeEntry(probeJson, { suiteId: args.suite, model: args.model });
    results = classifyRepeatCheck(entry, scenarioIds);
  } catch (err) {
    console.error(`classify-repeat-check.mjs: ${err.message}`);
    process.exit(1);
  }

  const lines = [];
  if (entry.status === 'errored') {
    lines.push('probe_status=errored');
    lines.push(`probe_reason=${entry.reason}`);
    for (const { scenarioId, verdict } of results) {
      lines.push(`scenario_id=${scenarioId} verdict=${verdict}`);
    }
  } else {
    for (const { scenarioId, outcomes, failCount, verdict } of results) {
      lines.push(
        `scenario_id=${scenarioId} outcomes=${outcomes.join(',')} fail_count=${failCount} verdict=${verdict}`,
      );
    }
    lines.push('probe_status=analyzed');
  }
  lines.push(`probe_json=${args['probe-json']}`);

  console.log(lines.join('\n'));
}

// realpathSync, not a raw pathToFileURL(process.argv[1]) comparison: this
// script is normally invoked through .claude/skills/.../classify-repeat-check.mjs,
// a symlink into .agents/skills — Node resolves import.meta.url to the
// symlink's target, so comparing against the unresolved argv[1] path never
// matches and main() silently never runs (exit 0, no output, no error).
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
