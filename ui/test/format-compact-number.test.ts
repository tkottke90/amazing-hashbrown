import { formatCompactNumber } from '@/lib/format-compact-number';

describe('formatCompactNumber', () => {
  it('returns the raw number unformatted below the k threshold [unit]', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('abbreviates into k, dropping a trailing .0 [unit]', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(100000)).toBe('100k');
  });

  it('abbreviates into k with one decimal place [unit]', () => {
    expect(formatCompactNumber(1500)).toBe('1.5k');
    expect(formatCompactNumber(12590)).toBe('12.6k');
  });

  it('abbreviates into M, dropping a trailing .0 [unit]', () => {
    expect(formatCompactNumber(1000000)).toBe('1M');
    expect(formatCompactNumber(2000000)).toBe('2M');
  });

  it('abbreviates into M with one decimal place [unit]', () => {
    expect(formatCompactNumber(1500000)).toBe('1.5M');
    expect(formatCompactNumber(178693706)).toBe('178.7M');
  });

  it('abbreviates into B, dropping a trailing .0 [unit]', () => {
    expect(formatCompactNumber(1000000000)).toBe('1B');
  });

  it('abbreviates into B with one decimal place [unit]', () => {
    expect(formatCompactNumber(1500000000)).toBe('1.5B');
  });

  it('rounds up within a tier without rolling over just below the boundary [unit]', () => {
    expect(formatCompactNumber(999949)).toBe('999.9k');
    expect(formatCompactNumber(999949999)).toBe('999.9M');
  });

  it('rolls over into the next tier when rounding would otherwise read e.g. "1000.0k" [unit]', () => {
    expect(formatCompactNumber(999950)).toBe('1M');
    expect(formatCompactNumber(999999)).toBe('1M');
    expect(formatCompactNumber(999950000)).toBe('1B');
    expect(formatCompactNumber(999999999)).toBe('1B');
  });
});
