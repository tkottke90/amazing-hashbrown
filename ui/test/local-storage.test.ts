import { readJson, writeJson } from '@/utils/local-storage';

describe('utils/local-storage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  it('round-trips a JSON value [unit]', () => {
    writeJson('k', { finished: true });
    expect(readJson('k', {})).toEqual({ finished: true });
  });

  it('returns the fallback when nothing is stored [unit]', () => {
    expect(readJson('missing', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns the fallback for a corrupt stored value instead of throwing [unit]', () => {
    window.localStorage.setItem('k', '{not json');
    expect(readJson('k', 'fallback')).toBe('fallback');
  });

  it('returns the fallback when storage is unavailable (private mode, blocked site data) [unit]', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readJson('k', 'fallback')).toBe('fallback');
  });

  it('swallows a failed write so a full or blocked store never breaks the page [unit]', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeJson('k', 1)).not.toThrow();
  });
});
