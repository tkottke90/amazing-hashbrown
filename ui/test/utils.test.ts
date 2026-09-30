import { truncateStart } from '@/lib/utils';

describe('truncateStart', () => {
  it('returns the input unchanged when it is at or under the max length', () => {
    expect(truncateStart('short')).toBe('short');
    expect(truncateStart('exactly-twenty-chars')).toBe('exactly-twenty-chars');
  });

  it('truncates from the start, keeping the trailing characters, once over the max length', () => {
    expect(truncateStart('/app/config/projects/infisical-setup')).toBe('...ects/infisical-setup');
  });

  it('respects a custom maxLength', () => {
    expect(truncateStart('/app/config/projects/infisical-setup', 8)).toBe('...al-setup');
    expect(truncateStart('short', 3)).toBe('...ort');
  });
});
