export interface WidgetFrontmatterInput {
  title: string;
  subtitle?: string;
  type: 'markdown';
  order: number;
  content: string;
}

/**
 * Minimal, dependency-free frontmatter+body serializer for the widget
 * drawer's Form→Raw handoff — mirrors `lib/amazing-hashbrown-widgets`'s
 * internal `gray-matter`-based serializer closely enough that the server's
 * real parser accepts the output identically, without a YAML writer in the
 * browser bundle (the UI only ever imports
 * `@tkottke90/amazing-hashbrown-widgets/types`, never `gray-matter`).
 *
 * Every string value is emitted as a YAML double-quoted scalar via
 * `JSON.stringify`: YAML double-quoted scalars accept the same
 * backslash-escaping as JSON for every character `JSON.stringify` ever
 * emits, and `JSON.stringify` never leaves a raw newline in the output, so
 * this sidesteps YAML's plain-scalar quoting ambiguity (leading `-`/`:`/`#`,
 * numbers-that-look-like-strings, a value that would read as its own
 * `---` fence) entirely instead of reimplementing it.
 */
export function serializeWidgetFile(input: WidgetFrontmatterInput): string {
  const lines = ['---', `title: ${JSON.stringify(input.title)}`];
  if (input.subtitle !== undefined) {
    lines.push(`subtitle: ${JSON.stringify(input.subtitle)}`);
  }
  lines.push(`type: ${JSON.stringify(input.type)}`);
  lines.push(`order: ${JSON.stringify(input.order)}`);
  lines.push('---', '', input.content.replace(/^\n+/, ''));
  return lines.join('\n');
}
