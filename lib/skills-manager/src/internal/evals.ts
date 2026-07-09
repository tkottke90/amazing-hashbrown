import type { EvalQuery, EvalQuerySplit, GradingResult, RunStats, TimingData } from '../types.js';

// Knuth's LCG (Numerical Recipes): a=1664525, c=1013904223, m=2^32
function lcgNext(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = lcgNext(s);
    const j = s % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const SHUFFLE_SEED = 42;

// Split a flat query list into train/validation subsets.
// Preserves proportional should_trigger balance across both sets.
// Shuffles deterministically so repeated calls on the same input produce the same split.
export function splitEvalQueries(queries: EvalQuery[], trainRatio = 0.6): EvalQuerySplit {
  const positive = queries.filter((q) => q.should_trigger);
  const negative = queries.filter((q) => !q.should_trigger);

  const shuffledPos = seededShuffle(positive, SHUFFLE_SEED);
  const shuffledNeg = seededShuffle(negative, SHUFFLE_SEED + 1);

  const posTrain = Math.round(shuffledPos.length * trainRatio);
  const negTrain = Math.round(shuffledNeg.length * trainRatio);

  return {
    train: [...shuffledPos.slice(0, posTrain), ...shuffledNeg.slice(0, negTrain)],
    validation: [...shuffledPos.slice(posTrain), ...shuffledNeg.slice(negTrain)],
  };
}

function computeStats(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

// Aggregate GradingResult objects into a RunStats block for benchmark.json.
// Pass timings (one per result) to include time_seconds and token stats.
export function aggregateBenchmark(results: GradingResult[], timings: TimingData[] = []): RunStats {
  const passRates = results.map((r) => r.summary.pass_rate);
  const timeSeconds = timings.map((t) => t.duration_ms / 1000);
  const tokens = timings.map((t) => t.total_tokens);
  return {
    pass_rate: computeStats(passRates),
    time_seconds: computeStats(timeSeconds),
    tokens: computeStats(tokens),
  };
}
