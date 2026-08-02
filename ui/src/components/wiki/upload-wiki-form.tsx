import { useEffect, useRef } from 'preact/hooks';
import { useSignal, effect } from '@preact/signals';
import { Upload, CheckCircle, XCircle, Loader2, Circle } from 'lucide-preact';
import { Dialog, useDialog } from '@tkottke90/preact-dialog';
import { domains, refreshDomains } from '@/hooks/use-wiki';
import {
  fetchUploadCapabilities,
  startWikiUpload,
  fetchUploadStatus,
} from '@/services/wiki-api';
import type { UploadJobState, UploadCapabilities } from '@/types/wiki-upload';
import { CodeBlock } from '../markdown';

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

const STEPS: Array<{ stage: string; label: string }> = [
  { stage: 'unpacking', label: 'Unpacking archive' },
  { stage: 'validating', label: 'Validating structure' },
  { stage: 'registering', label: 'Registering domain' },
  { stage: 'linting', label: 'Linting wiki' },
  { stage: 'embedding', label: 'Embedding pages' },
];

const STAGE_ORDER = [
  'pending', 'unpacking', 'validating', 'registering', 'linting', 'embedding', 'done',
];

function stageIndex(stage: string): number {
  return STAGE_ORDER.indexOf(stage);
}

// ---------------------------------------------------------------------------
// Step indicator row
// ---------------------------------------------------------------------------

function StepRow({ step, currentState }: {
  step: (typeof STEPS)[number];
  currentState: UploadJobState | null;
}) {
  if (!currentState) return null;

  const stage = currentState.stage;
  const isCurrent = stage === step.stage;
  const isDone = stageIndex(stage) > stageIndex(step.stage) || stage === 'done';
  const isFailed = stage === 'failed';

  let icon;
  if (isDone) {
    icon = <CheckCircle class="size-4 text-green-500 shrink-0" />;
  } else if (isCurrent && !isFailed) {
    icon = <Loader2 class="size-4 text-primary shrink-0 animate-spin" />;
  } else if (isFailed && stageIndex(stage as string) >= stageIndex(step.stage) && stageIndex(stage as string) <= stageIndex(step.stage)) {
    icon = <XCircle class="size-4 text-destructive shrink-0" />;
  } else {
    icon = <Circle class="size-4 text-muted-foreground shrink-0" />;
  }

  let label = step.label;
  if (isCurrent && currentState.stage === 'embedding') {
    const { pagesEmbedded, pagesTotal } = currentState;
    label = `${step.label}${pagesTotal > 0 ? ` (${pagesEmbedded} / ${pagesTotal})` : ''}`;
  }

  return (
    <div class={`flex items-center gap-2 text-xs ${isDone ? 'text-foreground' : isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function UploadWikiForm() {
  const { close } = useDialog();
  const capabilities = useSignal<UploadCapabilities | null>(null);

  // Form state
  const file = useSignal<File | null>(null);
  const name = useSignal('');
  const nameError = useSignal<string | null>(null);
  const dragging = useSignal(false);
  const submitting = useSignal(false);

  // Progress state
  const jobId = useSignal<string | null>(null);
  const jobState = useSignal<UploadJobState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load capabilities on mount
  useEffect(() => {
    void fetchUploadCapabilities().then((caps) => {
      capabilities.value = caps;
    });
  }, []);

  // Validate name against loaded domains (no extra fetch needed)
  useEffect(() =>
    effect(() => {
      const n = name.value.trim();
      if (!n) { nameError.value = null; return; }
      const taken = domains.value.some((d) => d.id === n);
      nameError.value = taken ? `"${n}" is already registered` : null;
    }),
  []);

  function reset() {
    file.value = null;
    name.value = '';
    nameError.value = null;
    dragging.value = false;
    submitting.value = false;
    jobId.value = null;
    jobState.value = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function handleClose() {
    reset();
    close();
  }

  function applyFile(f: File) {
    file.value = f;
    if (!name.value) {
      // Strip known extensions to derive the wiki ID suggestion
      name.value = f.name
        .replace(/\.(tar\.gz|tgz|tar|zip)$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
  }

  function handleFileInput(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) applyFile(f);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragging.value = false;
    const f = e.dataTransfer?.files[0];
    if (f) applyFile(f);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!file.value || nameError.value || submitting.value) return;
    const wikiName = name.value.trim();
    if (!wikiName) return;

    submitting.value = true;
    try {
      const result = await startWikiUpload(wikiName, file.value);
      jobId.value = result.jobId;
      jobState.value = { stage: 'pending' };

      pollRef.current = setInterval(async () => {
        if (!jobId.value) return;
        try {
          const state = await fetchUploadStatus(jobId.value);
          jobState.value = state;
          if (state.stage === 'done' || state.stage === 'failed') {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            if (state.stage === 'done') void refreshDomains();
          }
        } catch {
          // transient fetch error — keep polling
        }
      }, 1500);
    } catch (err) {
      submitting.value = false;
      jobState.value = { stage: 'failed', error: String(err) };
    }
  }

  const isInProgress = jobId.value !== null;
  const isDone = jobState.value?.stage === 'done';
  const isFailed = jobState.value?.stage === 'failed';
  const canSubmit = !!file.value && !nameError.value && !!name.value.trim() && !submitting.value;

  const accept = capabilities.value?.acceptedFormats.join(',') ?? '.tar.gz,.tgz,.tar';

  return (
    <div class="flex flex-col gap-4 text-xs">

      {/* ── Progress view ─────────────────────────────────────────────── */}
      {isInProgress && (
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2">
            {STEPS.map((step) => (
              <StepRow key={step.stage} step={step} currentState={jobState.value} />
            ))}
          </div>

          {isDone && (
            <div class="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-green-700 dark:text-green-400">
              Wiki imported successfully.
              {(() => {
                const state = jobState.value;
                if (state?.stage !== 'done') return null;
                const warns = state.lintReport.checks.filter((c) => c.severity !== 'error');
                if (!warns.length) return null;
                return (
                  <span class="block mt-1 text-muted-foreground">
                    {warns.length} lint finding{warns.length !== 1 ? 's' : ''} to review.
                  </span>
                );
              })()}
            </div>
          )}

          {isFailed && (
            <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              {jobState.value?.stage === 'failed' ? jobState.value.error : 'Upload failed'}
            </div>
          )}

          {(isDone || isFailed) && (
            <div class="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                class="rounded bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Form ──────────────────────────────────────────────────────── */}
      {!isInProgress && (
        <form onSubmit={(e) => void handleSubmit(e)} class="flex flex-col gap-3">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); dragging.value = true; }}
            onDragLeave={() => (dragging.value = false)}
            onDrop={handleDrop}
            class={`relative flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 transition-colors ${dragging.value ? 'border-primary bg-primary/5' : 'border-input'}`}
          >
            <Upload class="size-5 text-muted-foreground" />
            <span class="text-muted-foreground">
              {file.value ? file.value.name : 'Drop archive here or click to browse'}
            </span>
            <input
              type="file"
              accept={accept}
              onChange={handleFileInput}
              class="absolute inset-0 cursor-pointer opacity-0"
            />
          </div>

          {/* Wiki name */}
          <div class="flex flex-col gap-1">
            <input
              type="text"
              placeholder="Wiki ID (e.g. homelab)"
              value={name.value}
              onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
              class="rounded border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {nameError.value && (
              <span class="text-destructive">{nameError.value}</span>
            )}
          </div>

          {/* Buttons */}
          <div class="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              class="rounded px-2 py-1 text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              class="rounded bg-primary px-2 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Upload
            </button>
          </div>

          {/* Instructions */}
          <div class="border-t border-border pt-3">
            <p class="font-medium text-foreground mb-2">Creating an archive from your wiki:</p>
            <div class="flex flex-col gap-2">
              <div>
                <p class="text-muted-foreground mb-1">tar.gz (recommended):</p>
                <CodeBlock  >
                  tar -czf my-wiki.tar.gz -C /path/to/wiki .
                </CodeBlock>
              </div>
              {capabilities.value?.acceptedFormats.includes('.zip') && (
                <div>
                  <p class="text-muted-foreground mb-1">zip:</p>
                  <CodeBlock>
                    cd /path/to/wiki && zip -r ../my-wiki.zip .
                  </CodeBlock>
                </div>
              )}
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog wrapper
// ---------------------------------------------------------------------------

export function UploadWikiDialog() {
  return (
    <Dialog
      title="Upload Wiki"
      trigger={
        <button
          type="button"
          title="Upload Wiki"
          class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
        >
          <Upload class="size-3.5" />
        </button>
      }
    >
      <UploadWikiForm />
    </Dialog>
  );
}
