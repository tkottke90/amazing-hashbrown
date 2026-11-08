interface Tier {
  threshold: number;
  suffix: string;
}

// Largest tier first — formatCompactNumber walks down until it finds the
// one `value` belongs in, and "one tier up" is simply "the previous entry
// in this array" for the rollover fix below.
const TIERS: Tier[] = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'k' },
];

/**
 * Compact Number Format (GLOSSARY.md): abbreviates a number into its
 * largest applicable thousand/million/billion tier, rounded to at most one
 * decimal place, dropping the decimal when it rounds to `.0`.
 * e.g. 178693706 -> '178.7M', 12590 -> '12.6k'.
 *
 * Assumes a non-negative input (pie-chart slice values, token counts) —
 * this is the only domain this formatter is used in (D4/D6 of the design
 * doc); it is not a general-purpose number formatter.
 */
export function formatCompactNumber(value: number): string {
  if (value < 1_000) return String(value);

  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i]!;
    if (value < tier.threshold) continue;

    let scaled = roundToOneDecimal(value / tier.threshold);

    // Rounding can push the scaled value up to the next tier's own
    // boundary — e.g. 999,950 / 1,000 = 999.95, which rounds to 1000.0,
    // not 999.9 or 999.95. Printing "1000.0k" would be wrong: re-express
    // the same raw value one tier up instead, where it actually lands
    // (999,950 -> '1M', not '1000k').
    if (scaled >= 1000 && i > 0) {
      const tierUp = TIERS[i - 1]!;
      scaled = roundToOneDecimal(value / tierUp.threshold);
      return `${trimTrailingZero(scaled)}${tierUp.suffix}`;
    }

    return `${trimTrailingZero(scaled)}${tier.suffix}`;
  }

  // Unreachable: value >= 1_000 always matches the 'k' tier (the loop's
  // last entry), since TIERS[2].threshold === 1_000. Kept only to satisfy
  // TypeScript's control-flow analysis.
  return String(value);
}

function roundToOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

function trimTrailingZero(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
