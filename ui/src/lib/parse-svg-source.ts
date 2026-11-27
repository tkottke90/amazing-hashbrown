import { fromHtml } from 'hast-util-from-html';
import { sanitize } from 'hast-util-sanitize';
import type { Element, Root } from 'hast';
import { svgSanitizeSchema } from './markdown-sanitize-schema';

/**
 * Parses and sanitizes an SVG Widget's SVG Source (GLOSSARY.md). Valid means
 * the sanitized result is exactly one root `<svg>` element — no sibling
 * elements and no non-whitespace text. The HTML parser never throws, and the
 * sanitize schema unwraps disallowed tags rather than dropping their text, so
 * validity has to be decided from the resulting shape, not from a parse error.
 *
 * The returned tree is the already-sanitized one, safe to render as-is.
 */
export type ParsedSvgSource = { ok: true; svg: Element } | { ok: false };

export function parseSvgSource(source: string): ParsedSvgSource {
  const parsed = fromHtml(source, { fragment: true });
  const sanitized = sanitize(parsed, svgSanitizeSchema) as Root;

  const meaningful = sanitized.children.filter((node) => {
    if (node.type === 'comment') return false;
    if (node.type === 'text') return node.value.trim() !== '';
    return true;
  });

  const [only] = meaningful;
  if (meaningful.length !== 1 || only?.type !== 'element' || only.tagName !== 'svg') {
    return { ok: false };
  }
  return { ok: true, svg: only };
}
