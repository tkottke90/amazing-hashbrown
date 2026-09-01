import { useTitle } from '@/hooks/use-title';

interface PlaceholderPanelProps {
  title: string;
}

export function PlaceholderPanel({ title }: PlaceholderPanelProps) {
  useTitle(`Settings - ${title}`);

  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p class="text-base font-medium text-foreground">{title}</p>
      <p class="text-sm text-muted-foreground">Management UI coming soon.</p>
    </div>
  );
}
