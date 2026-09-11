import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { loadEvalsAction, saveEvalsAction } from '@/hooks/use-skills-panel';
import type { EvalCase } from '@/services/skills-manage-api';

function newCase(): EvalCase {
  return { id: crypto.randomUUID(), prompt: '', expected_output: '', assertions: [] };
}

export function SkillEvalsTab({ skillName }: { skillName: string }) {
  const evals = useSignal<EvalCase[] | null>(null);
  const saving = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void loadEvalsAction(skillName).then((suite) => {
      if (!cancelled) evals.value = suite?.evals ?? [];
    });
    return () => {
      cancelled = true;
    };
  }, [skillName]);

  function updateCase(index: number, patch: Partial<EvalCase>) {
    if (!evals.value) return;
    evals.value = evals.value.map((c, i) => (i === index ? { ...c, ...patch } : c));
  }

  function addCase() {
    evals.value = [...(evals.value ?? []), newCase()];
  }

  function removeCase(index: number) {
    if (!evals.value) return;
    evals.value = evals.value.filter((_, i) => i !== index);
  }

  function updateAssertions(index: number, text: string) {
    updateCase(index, {
      assertions: text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    });
  }

  async function handleSave() {
    if (!evals.value) return;
    saving.value = true;
    try {
      await saveEvalsAction(skillName, { skill_name: skillName, evals: evals.value });
    } finally {
      saving.value = false;
    }
  }

  if (evals.value === null) {
    return <div class="p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-4 p-4">
        {evals.value.length === 0 && (
          <p class="text-sm text-muted-foreground">No eval cases yet.</p>
        )}
        {evals.value.map((evalCase, index) => (
          <div key={evalCase.id} class="space-y-3 rounded-lg border border-border p-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-muted-foreground">Case {index + 1}</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => removeCase(index)}>
                Remove
              </Button>
            </div>
            <div class="space-y-1.5">
              <Label htmlFor={`eval-prompt-${evalCase.id}`}>Prompt</Label>
              <Textarea
                id={`eval-prompt-${evalCase.id}`}
                rows={2}
                value={evalCase.prompt}
                onInput={(e) =>
                  updateCase(index, { prompt: (e.target as HTMLTextAreaElement).value })
                }
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor={`eval-expected-${evalCase.id}`}>Expected output</Label>
              <Textarea
                id={`eval-expected-${evalCase.id}`}
                rows={2}
                value={evalCase.expected_output}
                onInput={(e) =>
                  updateCase(index, { expected_output: (e.target as HTMLTextAreaElement).value })
                }
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor={`eval-assertions-${evalCase.id}`}>Assertions (one per line)</Label>
              <Textarea
                id={`eval-assertions-${evalCase.id}`}
                rows={3}
                value={(evalCase.assertions ?? []).join('\n')}
                onInput={(e) => updateAssertions(index, (e.target as HTMLTextAreaElement).value)}
              />
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addCase}>
          + Add case
        </Button>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-border p-3">
        <Button type="button" disabled={saving.value} onClick={() => void handleSave()}>
          {saving.value ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
