// REST read-only wrappers for the wiki API endpoints.
// All writes go through the ingestion agent via SSE (see use-wiki-ingestion.ts).
import type { UploadCapabilities, UploadJobState } from '@/types/wiki-upload';

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

export async function fetchUploadCapabilities(): Promise<UploadCapabilities> {
  const res = await fetch('/api/v1/wiki/upload/capabilities');
  if (!res.ok) throw new Error(`Failed to fetch upload capabilities: ${res.status}`);
  return res.json() as Promise<UploadCapabilities>;
}

export async function startWikiUpload(name: string, file: File): Promise<{ jobId: string }> {
  const body = new FormData();
  body.append('name', name);
  body.append('file', file);
  const res = await fetch('/api/v1/wiki/upload', { method: 'POST', body });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `Upload failed: ${res.status}`);
  }
  return res.json() as Promise<{ jobId: string }>;
}

export async function fetchUploadStatus(jobId: string): Promise<UploadJobState> {
  const res = await fetch(`/api/v1/wiki/upload/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`Upload job not found: ${res.status}`);
  return res.json() as Promise<UploadJobState>;
}
