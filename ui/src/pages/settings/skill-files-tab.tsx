import { useSignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import type { EditorView } from '@codemirror/view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CodeEditor } from '@/pages/workspaces/code-editor';
import { saveSkillFileAction, deleteSkillFileAction } from '@/hooks/use-skills-panel';
import { fetchSkillFile, type SkillFileDir } from '@/services/skills-manage-api';
import { showToast } from '@/lib/toast';

interface SkillFilesTabProps {
  skillName: string;
  dir: SkillFileDir;
  files: Record<string, string>;
}

export function SkillFilesTab({ skillName, dir, files }: SkillFilesTabProps) {
  const openBasename = useSignal<string | null>(null);
  const openContent = useSignal('');
  const dirty = useSignal(false);
  const loading = useSignal(false);
  const saving = useSignal(false);
  const newFilename = useSignal('');
  const bodyViewRef = useRef<EditorView | null>(null);

  async function openFile(basename: string) {
    loading.value = true;
    try {
      const content = await fetchSkillFile(skillName, dir, basename);
      openBasename.value = basename;
      openContent.value = content;
      dirty.value = false;
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      loading.value = false;
    }
  }

  function startNewFile() {
    const name = newFilename.value.trim();
    if (!name) return;
    openBasename.value = name;
    openContent.value = '';
    dirty.value = false;
    newFilename.value = '';
  }

  async function handleSave() {
    if (!openBasename.value) return;
    saving.value = true;
    try {
      const content = bodyViewRef.current?.state.doc.toString() ?? openContent.value;
      const success = await saveSkillFileAction(skillName, dir, openBasename.value, content);
      if (success) dirty.value = false;
    } finally {
      saving.value = false;
    }
  }

  async function handleDelete(basename: string) {
    if (!confirm(`Delete "${basename}"? This cannot be undone.`)) return;
    const success = await deleteSkillFileAction(skillName, dir, basename);
    if (success && openBasename.value === basename) {
      openBasename.value = null;
    }
  }

  const basenames = Object.keys(files).sort();

  return (
    <div class="flex min-h-full">
      <div class="flex w-56 shrink-0 flex-col border-r border-border">
        <div class="flex items-center gap-1.5 border-b border-border p-2">
          <Input
            placeholder="filename.js"
            value={newFilename.value}
            onInput={(e) => (newFilename.value = (e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') startNewFile();
            }}
          />
          <Button type="button" size="sm" variant="outline" onClick={startNewFile}>
            Add
          </Button>
        </div>
        <div class="flex-1 overflow-y-auto">
          {basenames.length === 0 && (
            <p class="p-3 text-sm text-muted-foreground">No files yet.</p>
          )}
          <ul class="divide-y divide-border">
            {basenames.map((basename) => (
              <li key={basename} class="flex items-center justify-between gap-1 px-2 py-1.5">
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
                  onClick={() => void openFile(basename)}
                >
                  {basename}
                </button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void handleDelete(basename)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div class="flex flex-1 flex-col">
        {!openBasename.value ? (
          <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {loading.value ? 'Loading…' : 'Select or add a file to edit it.'}
          </div>
        ) : (
          <>
            <div class="flex items-center justify-between gap-2 border-b border-border p-2">
              <span class="truncate text-sm font-medium text-foreground">
                {openBasename.value}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={saving.value}
                onClick={() => void handleSave()}
              >
                {saving.value ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <div class="h-96 flex-1 overflow-hidden">
              <CodeEditor
                key={openBasename.value}
                path={openBasename.value}
                initialContent={openContent.value}
                dirty={dirty}
                onReady={(view) => {
                  bodyViewRef.current = view;
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
