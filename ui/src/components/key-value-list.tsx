import { useSignal } from '@preact/signals';
import { Plus, X } from 'lucide-preact';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface KeyValueRow {
  key: string;
  value: string;
}

interface KeyValueListProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
}

function toRecord(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
}

// Rows are seeded once from `value` and then locally owned (mirroring
// provider-modal.tsx's ProviderForm signals), rather than re-derived from
// `value` on every render — deriving straight from a Record while a key is
// being retyped would reorder/reflow rows mid-edit, since object key order
// shifts whenever a key changes. The parent remounts this component (via a
// `key` prop keyed off its own re-open counter) when it needs a fresh seed.
export function KeyValueList({
  value,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  addLabel,
}: KeyValueListProps) {
  const rows = useSignal<KeyValueRow[]>(
    Object.entries(value).map(([key, val]) => ({ key, value: val })),
  );

  function updateRow(idx: number, patch: Partial<KeyValueRow>) {
    const next = rows.value.map((row, i) => (i === idx ? { ...row, ...patch } : row));
    rows.value = next;
    onChange(toRecord(next));
  }

  function addRow() {
    rows.value = [...rows.value, { key: '', value: '' }];
  }

  function removeRow(idx: number) {
    const next = rows.value.filter((_, i) => i !== idx);
    rows.value = next;
    onChange(toRecord(next));
  }

  return (
    <div class="space-y-2">
      {rows.value.map((row, idx) => (
        <div key={idx} class="flex items-center gap-2">
          <Input
            value={row.key}
            onInput={(e) => updateRow(idx, { key: (e.target as HTMLInputElement).value })}
            placeholder={keyPlaceholder}
            class="flex-1"
            aria-label={`${keyPlaceholder} ${idx + 1}`}
          />
          <Input
            type="password"
            value={row.value}
            onInput={(e) => updateRow(idx, { value: (e.target as HTMLInputElement).value })}
            placeholder={valuePlaceholder}
            class="flex-1"
            aria-label={`${valuePlaceholder} ${idx + 1}`}
          />
          <button
            type="button"
            onClick={() => removeRow(idx)}
            class="shrink-0 rounded p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
            aria-label={`Remove ${row.key || 'entry'}`}
          >
            <X class="size-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus class="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}
