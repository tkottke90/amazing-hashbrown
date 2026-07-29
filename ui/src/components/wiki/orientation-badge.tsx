import { BookOpen } from 'lucide-preact';
import { wikiOrientedTo } from '@/hooks/use-wiki-ingestion';

export function OrientationBadge() {
  const domain = wikiOrientedTo.value;
  if (!domain) return null;

  return (
    <div class="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
      <BookOpen class="size-3 shrink-0" />
      <span class="font-medium">{domain}</span>
    </div>
  );
}
