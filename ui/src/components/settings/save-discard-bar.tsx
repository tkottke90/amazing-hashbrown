import { Loader2 } from 'lucide-preact';
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
    <div class="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-background px-6 py-3">
      <Button variant="ghost" size="sm" onClick={onDiscard} disabled={isSaving}>
        Discard
      </Button>
      <Button size="sm" onClick={onSave} disabled={isSaving}>
        {isSaving && <Loader2 class="mr-2 size-3.5 animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}
