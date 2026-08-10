import { Box, Lightbulb, GitCompare, Search, FileText } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';

export const PAGE_TYPE_ICON: Record<string, LucideIcon> = {
  entity: Box,
  concept: Lightbulb,
  comparison: GitCompare,
  query: Search,
  summary: FileText,
};

export const PAGE_TYPE_LABELS: Record<string, string> = {
  entity: 'Entities',
  concept: 'Concepts',
  comparison: 'Comparisons',
  query: 'Queries',
  summary: 'Summaries',
};
