import * as readline from 'node:readline';
import type { HumanScenario, Scoring } from '../schemas.js';

interface HumanDetails {
  type: 'human';
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  response?: string;
  reviewerNotes?: string;
}

export function runHumanSkipped(): HumanDetails {
  return { type: 'human', status: 'skipped' };
}

export function runHumanPending(): HumanDetails {
  return { type: 'human', status: 'pending' };
}

export function printDivider(): void {
  process.stdout.write('────────────────────────────────────────\n');
}

export function promptForNotes(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Notes (optional — press Enter to skip): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptKeypress(validKeys: string[]): Promise<string> {
  return new Promise((resolve) => {
    const lower = validKeys.map((k) => k.toLowerCase());
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (key: string) => {
      const k = key.toLowerCase();
      if (lower.includes(k)) {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(key + '\n');
        resolve(k);
      }
    };
    process.stdin.on('data', onData);
  });
}

function renderScoring(scoring: Scoring): void {
  if (scoring.type === 'choice') {
    const labels = scoring.options.map((o) => `[${o.key}] ${o.label}`).join('    ');
    process.stdout.write(`\n${labels}\n\n`);
  } else {
    const labels = scoring.options.map((o) => `[${o.value}] ${o.label}`).join('    ');
    process.stdout.write(`\n${labels}\n\n`);
  }
}

export async function runHumanInteractive(
  scenario: HumanScenario,
  actualOutput: string,
  scenarioIndex: number,
  totalScenarios: number,
): Promise<HumanDetails> {
  process.stdout.write(`\nHuman Scoring — ${scenarioIndex} of ${totalScenarios}\n`);
  printDivider();

  process.stdout.write(`\nInput:\n  ${scenario.input}\n`);
  process.stdout.write(`\nOutput:\n`);
  for (const line of actualOutput.split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  printDivider();
  process.stdout.write(`Rubric:\n  ${scenario.rubric}\n`);
  printDivider();

  renderScoring(scenario.scoring);
  process.stdout.write('> ');

  let responseKey: string;
  let passed: boolean;

  if (scenario.scoring.type === 'choice') {
    const validKeys = scenario.scoring.options.map((o) => o.key);
    responseKey = await promptKeypress(validKeys);
    const chosen = scenario.scoring.options.find((o) => o.key.toLowerCase() === responseKey);
    passed = chosen?.pass ?? false;
  } else {
    const validKeys = scenario.scoring.options.map((o) => String(o.value));
    responseKey = await promptKeypress(validKeys);
    const chosen = scenario.scoring.options.find((o) => String(o.value) === responseKey);
    const value = chosen?.value ?? 0;
    passed = value >= scenario.scoring.passingScore;
  }

  const notes = await promptForNotes();

  return {
    type: 'human',
    status: passed ? 'approved' : 'rejected',
    response: responseKey,
    reviewerNotes: notes || undefined,
  };
}
