import * as readline from 'node:readline/promises';

/**
 * Pauses the test and asks a human in the terminal to judge the result,
 * for outcomes too subjective (visual polish, "does this feel right") to
 * assert automatically. Answering "n" fails the test via a thrown error,
 * so the failure shows up in the report like any other assertion failure.
 *
 * Only works in an interactive terminal (`npm run test:local`, not CI) and
 * against one test at a time, so tag any spec that calls this with
 * CUSTOM_TAGS.LOCAL and run with `--workers=1` — otherwise prompts from
 * parallel tests interleave on stdin. `test:ci` already excludes @local.
 */
export async function promptPassFail(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(`${message} (y/n) `);
  } finally {
    rl.close();
  }

  if (answer.trim().toLowerCase() !== 'y') {
    throw new Error(`Manually marked as failed: ${message}`);
  }
}
