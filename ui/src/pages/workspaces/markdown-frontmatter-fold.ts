import type { EditorState, Text } from '@codemirror/state';

// A `---`-delimited frontmatter block at the very top of a Markdown file
// isn't a heading, list, or fenced code block, so @codemirror/lang-markdown's
// built-in folding doesn't treat it as one foldable unit. This only ever
// inspects line 1, so a `---` horizontal rule later in the body never
// misfires as a frontmatter delimiter.
export function frontmatterFoldRange(doc: Text): { from: number; to: number } | null {
  if (doc.lines < 2) return null;

  const firstLine = doc.line(1);
  if (firstLine.text.trim() !== '---') return null;

  for (let lineNumber = 2; lineNumber <= doc.lines; lineNumber++) {
    const line = doc.line(lineNumber);
    if (line.text.trim() === '---') {
      // Empty frontmatter block (closing delimiter immediately follows the
      // opening one) has nothing to collapse.
      if (lineNumber === 2) return null;
      return { from: firstLine.to, to: doc.line(lineNumber - 1).to };
    }
  }

  return null;
}

export function frontmatterFoldService(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  if (state.doc.lineAt(lineStart).number !== 1) return null;
  return frontmatterFoldRange(state.doc);
}
