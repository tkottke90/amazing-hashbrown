import { Input } from '@/components/ui/input';
import { slugify } from '@/lib/utils';

// Same id the server derives for a new wiki (projects.handlers.ts's
// wikiIdFromName: slugified, 60-char cap), so the form's collision check
// matches what the API will actually reject.
export function wikiIdFromName(name: string): string {
  return slugify(name);
}

/** Why a proposed new-wiki name can't be used, or null when it can. */
export function newWikiNameError(name: string, existingIds: string[]): string | null {
  const id = wikiIdFromName(name);
  if (!id) return 'Wiki name must contain letters or numbers.';
  if (existingIds.includes(id)) return `A wiki named "${id}" already exists.`;
  return null;
}

interface NewWikiNameFieldProps {
  value: string;
  error: string | null;
  onInput: (value: string) => void;
}

export function NewWikiNameField({ value, error, onInput }: NewWikiNameFieldProps) {
  return (
    <div class="flex flex-col gap-1">
      <label for="new-wiki-name" class="text-xs font-medium text-muted-foreground">
        Wiki name <span class="text-destructive">*</span>
      </label>
      <Input
        id="new-wiki-name"
        placeholder="Defaults to the workspace name"
        value={value}
        aria-invalid={error ? true : undefined}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      />
      {error && <p class="text-xs text-destructive">{error}</p>}
    </div>
  );
}
