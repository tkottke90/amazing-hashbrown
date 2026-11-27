import { parseSvgSource } from '../src/lib/parse-svg-source';

describe('parseSvgSource', () => {
  it('accepts a single root <svg> element [unit]', () => {
    const result = parseSvgSource('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.svg.tagName).toBe('svg');
  });

  it('accepts surrounding whitespace and comments around the root [unit]', () => {
    expect(parseSvgSource('\n  <!-- logo -->\n<svg></svg>\n').ok).toBe(true);
  });

  it('rejects an empty body [unit]', () => {
    expect(parseSvgSource('').ok).toBe(false);
    expect(parseSvgSource('   \n ').ok).toBe(false);
  });

  it('rejects plain text [unit]', () => {
    expect(parseSvgSource('just some words').ok).toBe(false);
  });

  it('rejects prose placed before the <svg> [unit]', () => {
    expect(parseSvgSource('Here you go: <svg></svg>').ok).toBe(false);
  });

  it('rejects two sibling <svg> roots [unit]', () => {
    expect(parseSvgSource('<svg></svg><svg></svg>').ok).toBe(false);
  });

  it('rejects a non-svg root element [unit]', () => {
    expect(parseSvgSource('<p>hi</p>').ok).toBe(false);
  });

  it('rejects a body that sanitizes away to nothing [unit]', () => {
    expect(parseSvgSource('<script>alert(1)</script>').ok).toBe(false);
  });

  it('returns a sanitized tree: handlers and <script> never survive [unit]', () => {
    const result = parseSvgSource('<svg onload="alert(1)"><script>alert(2)</script><rect/></svg>');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.svg)).not.toContain('onload');
      expect(JSON.stringify(result.svg)).not.toContain('alert');
    }
  });

  it('is not thrown by malformed markup — it just reports invalid or recovers [unit]', () => {
    expect(() => parseSvgSource('<svg><rect></svg')).not.toThrow();
    expect(() => parseSvgSource('<<<>>>')).not.toThrow();
  });
});
