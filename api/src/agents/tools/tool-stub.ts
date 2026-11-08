import { stringify } from 'yaml';

export interface StubSection {
  name: string;
  content: string;
}

// Shared across every offload+retrieve producer (web_fetch, attachment
// resolution, …) so they all agree on when content is "too large to return
// inline" and get_tool_key becomes the retrieval path instead.
export const STUB_THRESHOLD_CHARS = 10_000;

const OFFLOAD_HEADER = '── CONTENT OFFLOADED ──────────────────';
const SECTION_HEADER_WIDTH = 40;

function sectionHeader(name: string): string {
  const base = `─ ${name} `;
  return base + '─'.repeat(Math.max(0, SECTION_HEADER_WIDTH - base.length));
}

// content is the exact string being offloaded (already passed, or about to
// be passed, to storeToolContent at the call site) — not a preview or a
// derived summary. chars/lines are always derived from it here rather than
// trusted from the caller, so every producer's frontmatter numbers actually
// match what get_tool_key will return for that same content.
export function toolStub(
  content: string,
  frontmatter: Record<string, string | number | boolean>,
  sections: StubSection[],
): string {
  const lines = content === '' ? 0 : content.split('\n').length;
  const merged = { ...frontmatter, chars: content.length, lines };
  const parts: string[] = [OFFLOAD_HEADER, stringify(merged).trimEnd()];

  for (const section of sections) {
    parts.push(sectionHeader(section.name));
    parts.push(section.content);
  }

  return parts.join('\n');
}
