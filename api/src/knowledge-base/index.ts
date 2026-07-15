// Knowledge-base module. All domain state is derived at runtime from the
// on-disk registry — no domain definitions live in the repository.

import { getWikiRegistry, bootKnowledgeBase } from '../services/wiki.js';

export { getWikiRegistry, bootKnowledgeBase };

/** Return all active wiki entries from the on-disk registry. */
export async function getActiveDomains() {
  const registry = await getWikiRegistry();
  return registry.list();
}
