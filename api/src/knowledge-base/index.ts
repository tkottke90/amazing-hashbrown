// Knowledge base registry, following the LLM-Wiki pattern: each persona/topic
// domain owns its own folder under `domains/` with its source documents and
// retrieval index. This module will expose the domain registry once the
// first domain is implemented.

export interface KnowledgeDomain {
  id: string;
  name: string;
}

export const domains: KnowledgeDomain[] = [];
