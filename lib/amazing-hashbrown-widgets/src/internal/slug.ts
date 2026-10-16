import { randomUUID } from 'node:crypto';

/** Lowercase, hyphenate, strip non-alphanumerics; used for widget filenames. */
export function slugify(input: string, maxLength = 60): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Append the first 8 hex characters of a fresh UUID to `slug` — used when
 * `slug` already names an existing file. More collision-resistant than an
 * incrementing index, and needs no knowledge of what's already on disk
 * beyond "this exact name is taken."
 */
export function withCollisionSuffix(slug: string): string {
  return `${slug}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
