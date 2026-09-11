import { useSignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import type { EditorView } from '@codemirror/view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FormLayout } from '@/components/form-layout';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import { saveSkillDetails, deleteSkillAction } from '@/hooks/use-skills-panel';
import type { SkillDetail } from '@/services/skills-manage-api';
import { GATED_SKILL_NAMES } from './skill-gated-names';

export function SkillDetailsTab({ skill }: { skill: SkillDetail }) {
  const description = useSignal(skill.frontmatter.description);
  const license = useSignal(skill.frontmatter.license ?? '');
  // TODO: Allowed tools needs to become a dropdown over the system's actual
  // tool set, but the system doesn't yet reconcile/expose that list here.
  // Field disabled below until that design lands — see skill-gated-names.ts
  // for the one place tool names currently show up in this app.
  // const allowedTools = useSignal(skill.frontmatter['allowed-tools'] ?? '');
  const bodyDirty = useSignal(false);
  const saving = useSignal(false);
  const bodyViewRef = useRef<EditorView | null>(null);

  const isGated = GATED_SKILL_NAMES.includes(skill.name);

  async function handleSave() {
    saving.value = true;
    try {
      await saveSkillDetails(skill.name, {
        description: description.value,
        license: license.value || undefined,
        body: bodyViewRef.current?.state.doc.toString() ?? skill.body,
      });
      bodyDirty.value = false;
    } finally {
      saving.value = false;
    }
  }

  function handleDelete() {
    if (isGated) return;
    if (!confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return;
    void deleteSkillAction(skill.name);
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-4">
        <FormLayout>
          <div class="space-y-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input id="skill-name" value={skill.name} disabled readOnly />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              rows={2}
              value={description.value}
              onInput={(e) => (description.value = (e.target as HTMLTextAreaElement).value)}
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="skill-license">License</Label>
            <Input
              id="skill-license"
              value={license.value}
              onInput={(e) => (license.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          {/* TODO: Allowed tools should be a dropdown over the system's
              reconciled tool set once that exists — see the TODO above the
              (currently unused) allowedTools signal.
          <div class="space-y-1.5">
            <Label htmlFor="skill-allowed-tools">Allowed tools</Label>
            <Input
              id="skill-allowed-tools"
              value={allowedTools.value}
              onInput={(e) => (allowedTools.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          */}
        </FormLayout>

        <div class="space-y-1.5">
          <Label>Body</Label>
          <div class="h-96 overflow-hidden rounded-lg border border-input">
            <CodeEditor
              path={`skills/${skill.name}/SKILL.md`}
              initialContent={skill.body}
              dirty={bodyDirty}
              onReady={(view) => {
                bodyViewRef.current = view;
              }}
            />
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-2 border-t border-border p-3">
        <Button
          type="button"
          variant="destructive"
          disabled={isGated}
          title={isGated ? 'Required by tool-gating — cannot be deleted' : undefined}
          onClick={handleDelete}
        >
          Delete
        </Button>
        <Button type="button" disabled={saving.value} onClick={() => void handleSave()}>
          {saving.value ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
