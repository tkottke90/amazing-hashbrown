import { cn } from '@/lib/utils';

export type SettingsSlug =
  | 'general'
  | 'storage'
  | 'workspaces'
  | 'model-providers'
  | 'embeddings'
  | 'agent-behavior'
  | 'tools'
  | 'cost-rates'
  | 'mcp-servers'
  | 'skills';

const NAV_ITEMS: { label: string; slug: SettingsSlug }[] = [
  { label: 'General', slug: 'general' },
  { label: 'Storage', slug: 'storage' },
  { label: 'Workspaces', slug: 'workspaces' },
  { label: 'Model providers', slug: 'model-providers' },
  { label: 'Embeddings', slug: 'embeddings' },
  { label: 'Agent behavior', slug: 'agent-behavior' },
  { label: 'Tools', slug: 'tools' },
  { label: 'Cost rates', slug: 'cost-rates' },
  { label: 'MCP Servers', slug: 'mcp-servers' },
  { label: 'Skills', slug: 'skills' },
];

interface SettingsNavProps {
  activeSlug: SettingsSlug;
  onNavigate: (slug: SettingsSlug) => void;
}

export function SettingsNav({ activeSlug, onNavigate }: SettingsNavProps) {
  return (
    <nav
      class="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border p-3"
      aria-label="Settings navigation"
    >
      {NAV_ITEMS.map(({ label, slug }) => {
        const isActive = slug === activeSlug;
        return (
          <button
            key={slug}
            type="button"
            data-slot="settings-nav-item"
            data-active={isActive ? 'true' : 'false'}
            onClick={() => onNavigate(slug)}
            class={cn(
              'rounded-md px-3 py-1.5 text-left text-sm transition-colors',
              isActive
                ? 'bg-sidebar-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
            )}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

export const VALID_SLUGS = new Set<string>(NAV_ITEMS.map((i) => i.slug));
