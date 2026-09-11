import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { EditorView } from '@codemirror/view';
import { Drawer } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FormLayout } from '@/components/form-layout';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import { cn } from '@/lib/utils';
import {
  drawerOpen,
  creatingSkill,
  selectedSkill,
  selectedSkillLoading,
  createSkillAction,
  closeDrawer,
} from '@/hooks/use-skills-panel';
import { SkillDetailsTab } from './skill-details-tab';
import { SkillFilesTab } from './skill-files-tab';
import { SkillEvalsTab } from './skill-evals-tab';

type SkillTab = 'details' | 'scripts' | 'references' | 'evals';

const TABS: { id: SkillTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'references', label: 'References' },
  { id: 'evals', label: 'Evals' },
];

function SkillTabButton({
  isActive,
  onClick,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={cn(
        'border-b-2 px-3 py-1.5 text-sm transition-colors',
        isActive
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CreateSkillForm() {
  const name = useSignal('');
  const description = useSignal('');
  const bodyDirty = useSignal(false);
  const saving = useSignal(false);
  const bodyViewRef = useRef<EditorView | null>(null);

  async function handleSave() {
    if (!name.value.trim() || !description.value.trim()) return;
    saving.value = true;
    try {
      await createSkillAction({
        name: name.value.trim(),
        description: description.value.trim(),
        body: bodyViewRef.current?.state.doc.toString() ?? '',
      });
    } finally {
      saving.value = false;
    }
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 overflow-y-auto p-4">
        <FormLayout>
          <div class="space-y-1.5">
            <Label htmlFor="new-skill-name">Name</Label>
            <Input
              id="new-skill-name"
              placeholder="my-new-skill"
              value={name.value}
              onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="new-skill-description">Description</Label>
            <Textarea
              id="new-skill-description"
              rows={2}
              value={description.value}
              onInput={(e) => (description.value = (e.target as HTMLTextAreaElement).value)}
            />
          </div>
        </FormLayout>
        <div class="space-y-1.5">
          <Label>Body</Label>
          <div class="h-96 overflow-hidden rounded-lg border border-input">
            <CodeEditor
              path="new-skill/SKILL.md"
              initialContent=""
              dirty={bodyDirty}
              onReady={(view) => {
                bodyViewRef.current = view;
              }}
            />
          </div>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 border-t border-border p-3">
        <Button type="button" variant="ghost" onClick={closeDrawer}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={saving.value || !name.value.trim() || !description.value.trim()}
          onClick={() => void handleSave()}
        >
          {saving.value ? 'Creating…' : 'Create skill'}
        </Button>
      </div>
    </div>
  );
}

function EditSkillView() {
  const activeTab = useSignal<SkillTab>('details');

  useEffect(() => {
    activeTab.value = 'details';
  }, [selectedSkill.value?.name]);

  if (selectedSkillLoading.value) {
    return (
      <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!selectedSkill.value) {
    return (
      <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
        Failed to load this skill.
      </div>
    );
  }

  const skill = selectedSkill.value;

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-1 border-b border-border px-2">
        {TABS.map((tab) => (
          <SkillTabButton
            key={tab.id}
            isActive={activeTab.value === tab.id}
            onClick={() => (activeTab.value = tab.id)}
          >
            {tab.label}
          </SkillTabButton>
        ))}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        {activeTab.value === 'details' && <SkillDetailsTab key={skill.name} skill={skill} />}
        {activeTab.value === 'scripts' && (
          <SkillFilesTab
            key={skill.name}
            skillName={skill.name}
            dir="scripts"
            files={skill.scripts}
          />
        )}
        {activeTab.value === 'references' && (
          <SkillFilesTab
            key={skill.name}
            skillName={skill.name}
            dir="references"
            files={skill.references}
          />
        )}
        {activeTab.value === 'evals' && <SkillEvalsTab key={skill.name} skillName={skill.name} />}
      </div>
    </div>
  );
}

export function SkillDrawer() {
  // The X button and Escape both close the dialog natively without going
  // through closeDrawer() — Dialog only syncs drawerOpen.value back to
  // false on those paths (see Dialog.tsx's 'close' event listener). This
  // effect catches that and clears the rest of the selection/create state,
  // so any close path behaves the same as clicking Cancel.
  useEffect(() => {
    if (!drawerOpen.value) closeDrawer();
  }, [drawerOpen.value]);

  return (
    <Drawer
      open={drawerOpen}
      title={creatingSkill.value ? 'New skill' : (selectedSkill.value?.name ?? 'Skill')}
      className="w-[90vw]! rounded-none! border-0! bg-background! p-0! border-l border-border sm:w-9/12! sm:max-w-[90vw]!"
    >
      {creatingSkill.value ? <CreateSkillForm /> : <EditSkillView />}
    </Drawer>
  );
}
