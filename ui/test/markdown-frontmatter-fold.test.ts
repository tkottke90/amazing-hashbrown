import { Text } from '@codemirror/state';

import { frontmatterFoldRange } from '@/pages/workspaces/markdown-frontmatter-fold';

function doc(lines: string[]) {
  return Text.of(lines);
}

describe('frontmatterFoldRange', () => {
  it('returns the range between the delimiters for valid frontmatter', () => {
    const d = doc(['---', 'title: Hello', 'tags: [a, b]', '---', '# Body']);

    const range = frontmatterFoldRange(d);

    expect(range).toEqual({ from: d.line(1).to, to: d.line(3).to });
  });

  it('returns null when --- only appears later in the body, not on line 1', () => {
    const d = doc(['# Heading', 'some text', '---', 'more text']);

    expect(frontmatterFoldRange(d)).toBeNull();
  });

  it('returns null when there is no closing delimiter', () => {
    const d = doc(['---', 'title: Hello', 'unterminated']);

    expect(frontmatterFoldRange(d)).toBeNull();
  });

  it('returns null for an empty frontmatter block', () => {
    const d = doc(['---', '---', '# Body']);

    expect(frontmatterFoldRange(d)).toBeNull();
  });

  it('returns null for a single-line document', () => {
    expect(frontmatterFoldRange(doc(['---']))).toBeNull();
  });

  it('returns null for an empty document', () => {
    expect(frontmatterFoldRange(doc(['']))).toBeNull();
  });
});
