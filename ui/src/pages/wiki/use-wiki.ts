import { signal } from '@preact/signals';
import {
  fetchDomains,
  fetchGraph,
  fetchPages,
  fetchPage,
  type WikiDomain,
  type WikiGraph,
  type WikiPageSummary,
  type WikiPageContent,
} from '@/services/wiki-api';

// ---- Module-level signals ----

export const domains = signal<WikiDomain[]>([]);
export const graphData = signal<WikiGraph>({ nodes: [], edges: [] });
export const graphRefreshing = signal(false);
export const activeDomainId = signal<string | null>(null);
export const pageList = signal<WikiPageSummary[]>([]);
export const activePage = signal<WikiPageContent | null>(null);
export const activePagePath = signal<string | null>(null);
export const enabledDomainIds = signal<Set<string>>(new Set());

// ---- Actions ----

export async function refreshDomains(): Promise<void> {
  try {
    const result = await fetchDomains();
    domains.value = result;
    // Auto-enable all domains in the graph filter by default
    enabledDomainIds.value = new Set(result.map((d) => d.id));
    // Default active domain to the first one if none selected
    if (!activeDomainId.value && result.length > 0) {
      activeDomainId.value = result[0]!.id;
    }
  } catch {
    // Leave stale — best effort
  }
}

export async function refreshGraph(): Promise<void> {
  graphRefreshing.value = true;
  try {
    const result = await fetchGraph();
    graphData.value = result;
  } catch {
    // Leave stale
  } finally {
    graphRefreshing.value = false;
  }
}

export async function refreshPages(domainId: string): Promise<void> {
  try {
    const result = await fetchPages(domainId);
    pageList.value = result;
  } catch {
    pageList.value = [];
  }
}

export async function loadPage(domainId: string, pagePath: string): Promise<void> {
  try {
    const result = await fetchPage(domainId, pagePath);
    activePage.value = result;
    activePagePath.value = pagePath;
    activeDomainId.value = domainId;
  } catch {
    // Leave stale
  }
}

export function toggleDomain(domainId: string, enabled: boolean): void {
  const next = new Set(enabledDomainIds.value);
  if (enabled) {
    next.add(domainId);
  } else {
    next.delete(domainId);
  }
  enabledDomainIds.value = next;
}
