import { domains, enabledDomainIds, toggleDomain } from '@/hooks/use-wiki';

// Fixed 6-color palette cycling by index
const DOMAIN_COLORS = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
];

export function getDomainColor(index: number): string {
  return DOMAIN_COLORS[index % DOMAIN_COLORS.length] ?? DOMAIN_COLORS[0]!;
}

export function DomainFilter() {
  const allDomains = domains.value;
  const enabled = enabledDomainIds.value;

  if (allDomains.length === 0) return null;

  return (
    <div class="flex flex-wrap items-center gap-2">
      {allDomains.map((domain, index) => {
        const color = getDomainColor(index);
        const isEnabled = enabled.has(domain.id);

        return (
          <button
            key={domain.id}
            type="button"
            onClick={() => toggleDomain(domain.id, !isEnabled)}
            class={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-opacity ${
              isEnabled ? 'opacity-100' : 'opacity-40'
            }`}
            style={{ borderColor: color }}
            title={domain.domain}
          >
            <span
              class="inline-block size-2 rounded-full shrink-0"
              style={{ backgroundColor: color }}
            />
            <span>{domain.id}</span>
          </button>
        );
      })}
    </div>
  );
}
