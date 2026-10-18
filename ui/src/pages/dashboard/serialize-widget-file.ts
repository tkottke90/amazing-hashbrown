export type WidgetFrontmatterInput =
  | { type: 'markdown'; title: string; subtitle?: string; order: number; content: string }
  | {
      type: 'big-number';
      title: string;
      subtitle?: string;
      order: number;
      value?: number;
      unit?: string;
    }
  | {
      type: 'line-graph';
      title: string;
      subtitle?: string;
      order: number;
      data: string;
      color?: string;
    }
  | {
      type: 'pie-graph';
      title: string;
      subtitle?: string;
      order: number;
      data: string;
      colors?: string[];
    }
  | {
      type: 'system';
      title: string;
      subtitle?: string;
      order: number;
      metric: string;
    }
  // subtitle kept optional (never populated in practice — Spacer has no UI
  // field for it) purely so the shared prefix logic below can read
  // `input.subtitle` generically, same as every other member.
  | { type: 'spacer'; title: string; subtitle?: string; order: number };

function assertNeverWidgetType(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
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
 * `---` fence) entirely instead of reimplementing it. An array (Pie
 * Graph's `colors`) is emitted the same way — `JSON.stringify` of a
 * string array is already a valid YAML flow sequence.
 *
 * Per-type persistence shape (ADR-0002): Markdown's body is its prose
 * `content`; Big Number has no body; Line/Pie Graph's body is their CSV
 * Body (`data`), verbatim.
 */
export function serializeWidgetFile(input: WidgetFrontmatterInput): string {
  const lines = ['---', `title: ${JSON.stringify(input.title)}`];
  if (input.subtitle !== undefined) {
    lines.push(`subtitle: ${JSON.stringify(input.subtitle)}`);
  }
  lines.push(`type: ${JSON.stringify(input.type)}`);
  lines.push(`order: ${JSON.stringify(input.order)}`);

  let body: string;
  switch (input.type) {
    case 'markdown':
      body = input.content;
      break;
    case 'big-number':
      if (input.value !== undefined) lines.push(`value: ${JSON.stringify(input.value)}`);
      if (input.unit !== undefined) lines.push(`unit: ${JSON.stringify(input.unit)}`);
      body = '';
      break;
    case 'line-graph':
      if (input.color !== undefined) lines.push(`color: ${JSON.stringify(input.color)}`);
      body = input.data;
      break;
    case 'pie-graph':
      if (input.colors !== undefined) lines.push(`colors: ${JSON.stringify(input.colors)}`);
      body = input.data;
      break;
    case 'system':
      // No Widget Payload (ADR-0011) — functionally unreachable, since the
      // drawer hides the Form/Raw tab toggle entirely for this type, but
      // required here to satisfy assertNeverWidgetType.
      lines.push(`metric: ${JSON.stringify(input.metric)}`);
      body = '';
      break;
    case 'spacer':
      body = '';
      break;
    default:
      return assertNeverWidgetType(input);
  }

  lines.push('---', '', body.replace(/^\n+/, ''));
  return lines.join('\n');
}
