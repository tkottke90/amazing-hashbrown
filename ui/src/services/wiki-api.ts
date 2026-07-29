// REST read-only wrappers for the wiki API endpoints.
// All writes go through the ingestion agent via SSE (see use-wiki-ingestion.ts).

export interface WikiDomain {
  id: string;
  domain: string;
  tags: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
  domainId: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'references' | 'contradicts' | 'derived_from';
  domainId: string;
}

export interface WikiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WikiPageSummary {
  filename: string;
  title: string;
  type: string;
  tags: string[];
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
}

export interface WikiPageContent {
  filename: string;
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export async function fetchDomains(): Promise<WikiDomain[]> {
  const res = await fetch('/api/v1/wiki/domains');
  if (!res.ok) throw new Error(`Failed to fetch domains: ${res.status}`);
  return res.json() as Promise<WikiDomain[]>;
}

export async function fetchGraph(): Promise<WikiGraph> {
  const res = await fetch('/api/v1/wiki/graph');
  if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
  return res.json() as Promise<WikiGraph>;
}

export async function fetchPages(domainId: string): Promise<WikiPageSummary[]> {
  const res = await fetch(`/api/v1/wiki/domains/${encodeURIComponent(domainId)}/pages`);
  if (!res.ok) throw new Error(`Failed to fetch pages for ${domainId}: ${res.status}`);
  return res.json() as Promise<WikiPageSummary[]>;
}

export async function fetchPage(domainId: string, pagePath: string): Promise<WikiPageContent> {
  const res = await fetch(`/api/v1/wiki/domains/${encodeURIComponent(domainId)}/pages/${pagePath}`);
  if (!res.ok) throw new Error(`Failed to fetch page ${pagePath}: ${res.status}`);
  return res.json() as Promise<WikiPageContent>;
}
