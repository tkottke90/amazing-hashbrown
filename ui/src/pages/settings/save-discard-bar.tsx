import { AlertCircle, Loader2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';

interface SaveDiscardBarProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

export function SaveDiscardBar({ isDirty, isSaving, onSave, onDiscard }: SaveDiscardBarProps) {
  if (!isDirty) return null;

  return (
    <div class="sticky bottom-0 flex items-center justify-between gap-2 border-t border-primary/30 bg-primary/10 px-6 py-3 shadow-[0_-4px_12px_-4px_rgb(0_0_0_/_0.15)]">
      <div class="flex items-center gap-2 text-sm font-medium text-primary">
        <AlertCircle class="size-4" />
        Unsaved changes
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={isSaving}>
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>
          {isSaving && <Loader2 class="mr-2 size-3.5 animate-spin" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
