/** Content hashing + drift detection. Pure — operates on strings. */

import { createHash } from 'node:crypto';

/**
 * Extract the body of a markdown document, dropping a leading `---` frontmatter
 * block if present. Mirrors the skill's body-only hashing so the hash is stable
 * across frontmatter edits.
 */
export function extractBody(content: string): string {
  if (!content.startsWith('---')) return content;
  const lines = content.split('\n');
  let dashes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      dashes++;
      if (dashes === 2) return lines.slice(i + 1).join('\n');
    }
  }
  return content;
}

/** SHA256 hex digest of a string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA256 of the body only (frontmatter stripped). */
export function sha256Body(content: string): string {
  return sha256(extractBody(content));
}
