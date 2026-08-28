import { useEffect } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { useLocation } from 'preact-iso';
import { ChevronRight, CheckCircle, Circle, Loader2 } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  workspaces,
  refreshWorkspaces,
  getProjectForWorkspace,
  snapshotProject,
  patchProjectCloseProgress,
  cleanupDependencies,
  completeCloseProject,
} from '@/hooks/use-workspaces';
import {
  fetchDomains,
  fetchPages,
  type WikiDomain,
  type WikiPageSummary,
} from '@/services/wiki-api';
import type { Workspace, Project } from '@/services/workspaces-api';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// ---------------------------------------------------------------------------
// Step derivation — the persisted project fields ARE the progress, so the
// current step is always recomputed from them rather than tracked
// separately. This is what makes a reload land back on the right step.
// ---------------------------------------------------------------------------

type CloseStep = 1 | 2 | 3 | 4;

function deriveStep(project: Project): CloseStep {
  if (!project.snapshotPath) return 1;
  if (project.closeProgress?.mergeSelections === undefined) return 2;
  if (project.closeProgress?.dependencySelections === undefined) return 3;
  return 4;
}

const STEP_LABELS: Record<CloseStep, string> = {
  1: 'Wiki snapshot',
  2: 'Selective merge',
  3: 'Dependency cleanup',
  4: 'Review & close',
};

// Forward-only: this is a progress indicator, not a nav control — no click
// handlers, no way to revisit a completed step.
function StepIndicator({ current }: { current: CloseStep }) {
  return (
    <div class="flex flex-col gap-3">
      {([1, 2, 3, 4] as CloseStep[]).map((step) => {
        const isDone = step < current;
        const isCurrent = step === current;
        return (
          <div
            key={step}
            class={cn(
              'flex items-center gap-2 text-sm',
              isDone
                ? 'text-foreground'
                : isCurrent
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
            )}
          >
            {isDone ? (
              <CheckCircle class="size-4 text-green-500 shrink-0" />
            ) : (
              <Circle class={cn('size-4 shrink-0', isCurrent && 'text-primary')} />
            )}
            <span>
              {step}. {STEP_LABELS[step]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Wiki snapshot
// ---------------------------------------------------------------------------

function SnapshotStep({ workspaceId }: { workspaceId: string }) {
  const running = useSignal(false);
  const error = useSignal<string | null>(null);

  async function runSnapshot() {
    running.value = true;
    error.value = null;
    try {
      await snapshotProject(workspaceId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to snapshot the project wiki.';
    } finally {
      running.value = false;
    }
  }

  useEffect(() => {
    void runSnapshot();
  }, [workspaceId]);

  return (
    <div class="p-4 flex flex-col gap-3 max-w-md">
      <h2 class="text-sm font-semibold">Wiki snapshot</h2>
      <p class="text-xs text-muted-foreground">
        Copying the project wiki so its knowledge survives independently of this close process.
      </p>

      {running.value && (
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" />
          Snapshotting…
        </div>
      )}

      {error.value && (
        <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive flex flex-col gap-2">
          <span>{error.value}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runSnapshot()}
            disabled={running.value}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Selective merge
// ---------------------------------------------------------------------------

function MergeStep({ workspace }: { workspace: Workspace }) {
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);
  const pages = useSignal<WikiPageSummary[]>([]);
  const domains = useSignal<WikiDomain[]>([]);
  // filename -> chosen target domain id ('' = checked but no target yet)
  const selected = useSignal<Record<string, string>>({});
  const saving = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      loading.value = true;
      error.value = null;
      try {
        const [p, d] = await Promise.all([
          workspace.wikiId ? fetchPages(workspace.wikiId) : Promise.resolve([]),
          fetchDomains(),
        ]);
        if (cancelled) return;
        pages.value = p;
        domains.value = d.filter((dom) => dom.id !== workspace.wikiId);
      } catch (err) {
        if (!cancelled) {
          error.value = err instanceof Error ? err.message : 'Failed to load wiki pages.';
        }
      } finally {
        if (!cancelled) loading.value = false;
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspace.wikiId]);

  function toggle(filename: string, checked: boolean) {
    const next = { ...selected.value };
    if (checked) next[filename] = next[filename] ?? '';
    else delete next[filename];
    selected.value = next;
  }

  function selectAll() {
    const next: Record<string, string> = {};
    for (const page of pages.value) next[page.filename] = selected.value[page.filename] ?? '';
    selected.value = next;
  }

  function deselectAll() {
    selected.value = {};
  }

  const canContinue = Object.values(selected.value).every((target) => target !== '');

  async function handleContinue() {
    saving.value = true;
    try {
      const mergeSelections = Object.entries(selected.value).map(([filename, targetDomainId]) => ({
        filename,
        targetDomainId,
      }));
      await patchProjectCloseProgress(workspace.id, { mergeSelections });
    } finally {
      saving.value = false;
    }
  }

  async function handleSkip() {
    saving.value = true;
    try {
      await patchProjectCloseProgress(workspace.id, { mergeSelections: [] });
    } finally {
      saving.value = false;
    }
  }

  return (
    <div class="p-4 flex flex-col gap-3 max-w-2xl">
      <h2 class="text-sm font-semibold">Selective merge</h2>
      <p class="text-xs text-muted-foreground">
        Choose which pages from this project's wiki should carry forward into another domain.
      </p>

      {loading.value && (
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" />
          Loading wiki pages…
        </div>
      )}
      {error.value && <p class="text-sm text-destructive">{error.value}</p>}

      {!loading.value && !error.value && (
        <>
          {pages.value.length === 0 ? (
            <p class="text-sm text-muted-foreground">This project's wiki has no pages to merge.</p>
          ) : (
            <>
              <div class="flex gap-2">
                <Button size="sm" variant="outline" onClick={selectAll}>
                  Select all
                </Button>
                <Button size="sm" variant="outline" onClick={deselectAll}>
                  Deselect all
                </Button>
              </div>
              <div class="flex flex-col gap-2 border border-border rounded-lg p-3">
                {pages.value.map((page) => {
                  const checked = page.filename in selected.value;
                  return (
                    <div key={page.filename} class="flex items-center gap-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggle(page.filename, v === true)}
                      />
                      <span class="text-sm flex-1">{page.title}</span>
                      <Select
                        value={selected.value[page.filename] ?? ''}
                        onValueChange={(v) => {
                          selected.value = { ...selected.value, [page.filename]: v };
                        }}
                        disabled={!checked}
                      >
                        <SelectTrigger class="w-48">
                          <SelectValue placeholder="Target domain" />
                        </SelectTrigger>
                        <SelectContent>
                          {domains.value.map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.domain || d.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div class="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSkip()}
              disabled={saving.value}
            >
              Skip this step
            </Button>
            <Button
              size="sm"
              onClick={() => void handleContinue()}
              disabled={!canContinue || saving.value}
            >
              Continue
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Dependency cleanup
// ---------------------------------------------------------------------------

function CleanupStep({ workspace }: { workspace: Workspace }) {
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);
  const candidates = useSignal<{ path: string; sizeBytes: number }[]>([]);
  const removeJs = useSignal(true);
  const removePy = useSignal(true);
  const cleaning = useSignal(false);
  const skipping = useSignal(false);
  const freed = useSignal<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function scan() {
      loading.value = true;
      error.value = null;
      try {
        const res = await cleanupDependencies(workspace.id, {
          removeNodeModules: workspace.javascript,
          removePythonEnv: workspace.python,
          dryRun: true,
        });
        if (cancelled) return;
        const found = res.dryRun ? res.candidates : [];
        candidates.value = found;
        if (found.length === 0) {
          // Nothing to clean up — auto-advance past this step.
          await patchProjectCloseProgress(workspace.id, {
            dependencySelections: { removeNodeModules: false, removePythonEnv: false },
          });
        }
      } catch (err) {
        if (!cancelled) {
          error.value = err instanceof Error ? err.message : 'Failed to scan for dependencies.';
        }
      } finally {
        if (!cancelled) loading.value = false;
      }
    }
    void scan();
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const jsFound = candidates.value.some((c) => c.path === 'node_modules');
  const pyFound = candidates.value.some((c) => c.path !== 'node_modules');
  const jsSize = candidates.value
    .filter((c) => c.path === 'node_modules')
    .reduce((sum, c) => sum + c.sizeBytes, 0);
  const pySize = candidates.value
    .filter((c) => c.path !== 'node_modules')
    .reduce((sum, c) => sum + c.sizeBytes, 0);

  async function handleCleanup() {
    cleaning.value = true;
    try {
      const removeNodeModules = jsFound && removeJs.value;
      const removePythonEnv = pyFound && removePy.value;
      const res = await cleanupDependencies(workspace.id, { removeNodeModules, removePythonEnv });
      if (!res.dryRun) freed.value = res.bytesFreed;
      await patchProjectCloseProgress(workspace.id, {
        dependencySelections: { removeNodeModules, removePythonEnv },
      });
    } finally {
      cleaning.value = false;
    }
  }

  async function handleSkip() {
    skipping.value = true;
    try {
      await patchProjectCloseProgress(workspace.id, {
        dependencySelections: { removeNodeModules: false, removePythonEnv: false },
      });
    } finally {
      skipping.value = false;
    }
  }

  return (
    <div class="p-4 flex flex-col gap-3 max-w-md">
      <h2 class="text-sm font-semibold">Dependency cleanup</h2>

      {loading.value && (
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" />
          Scanning workspace…
        </div>
      )}
      {error.value && <p class="text-sm text-destructive">{error.value}</p>}

      {!loading.value &&
        !error.value &&
        (candidates.value.length === 0 ? (
          <p class="text-sm text-muted-foreground">
            No JavaScript or Python dependency directories found — nothing to clean up.
          </p>
        ) : (
          <>
            <div class="flex flex-col gap-2 border border-border rounded-lg p-3">
              {jsFound && (
                <div class="flex items-center gap-2">
                  <Checkbox
                    checked={removeJs.value}
                    onCheckedChange={(v) => (removeJs.value = v === true)}
                  />
                  <span class="text-sm flex-1">node_modules</span>
                  <span class="text-xs text-muted-foreground">{formatBytes(jsSize)}</span>
                </div>
              )}
              {pyFound && (
                <div class="flex items-center gap-2">
                  <Checkbox
                    checked={removePy.value}
                    onCheckedChange={(v) => (removePy.value = v === true)}
                  />
                  <span class="text-sm flex-1">venv / .venv / __pycache__</span>
                  <span class="text-xs text-muted-foreground">{formatBytes(pySize)}</span>
                </div>
              )}
            </div>

            {freed.value !== null && (
              <p class="text-sm text-green-600 dark:text-green-400">
                Freed {formatBytes(freed.value)}.
              </p>
            )}

            <div class="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSkip()}
                disabled={skipping.value || cleaning.value}
              >
                Skip this step
              </Button>
              <Button
                size="sm"
                onClick={() => void handleCleanup()}
                disabled={cleaning.value || (!removeJs.value && !removePy.value)}
              >
                Clean up selected
              </Button>
            </div>
          </>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Review & close
// ---------------------------------------------------------------------------

function ReviewStep({ workspace, project }: { workspace: Workspace; project: Project }) {
  const { route } = useLocation();
  const completing = useSignal(false);
  const error = useSignal<string | null>(null);
  const failedPages = useSignal<{ filename: string; error: string }[]>([]);

  async function handleComplete() {
    completing.value = true;
    error.value = null;
    try {
      const result = await completeCloseProject(workspace.id);
      if (result.failed.length > 0) {
        failedPages.value = result.failed;
        return;
      }
      route(`/workspaces/${workspace.id}`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to complete the close.';
    } finally {
      completing.value = false;
    }
  }

  const mergeSelections = project.closeProgress?.mergeSelections ?? [];
  const dependencySelections = project.closeProgress?.dependencySelections;
  const cleanedUp =
    dependencySelections?.removeNodeModules || dependencySelections?.removePythonEnv;
  const buttonLabel = project.closeIntent === 'abandon' ? 'Complete abandonment' : 'Complete close';

  return (
    <div class="p-4 flex flex-col gap-4 max-w-xl">
      <h2 class="text-sm font-semibold">Review &amp; close</h2>

      <div class="border border-border rounded-lg p-3 flex flex-col gap-1">
        <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Snapshot</p>
        <p class="text-sm font-mono break-all">{project.snapshotPath}</p>
      </div>

      <div class="border border-border rounded-lg p-3 flex flex-col gap-1">
        <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Pages merged
        </p>
        {mergeSelections.length === 0 ? (
          <p class="text-sm text-muted-foreground">No pages merged</p>
        ) : (
          <ul class="text-sm flex flex-col gap-0.5">
            {mergeSelections.map((m) => (
              <li key={m.filename}>
                {m.filename} → {m.targetDomainId}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="border border-border rounded-lg p-3 flex flex-col gap-1">
        <p class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Dependencies removed
        </p>
        {cleanedUp ? (
          <p class="text-sm">
            {[
              dependencySelections?.removeNodeModules && 'node_modules',
              dependencySelections?.removePythonEnv && 'Python env',
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        ) : (
          <p class="text-sm text-muted-foreground">No cleanup performed</p>
        )}
      </div>

      {failedPages.value.length > 0 && (
        <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive flex flex-col gap-1">
          <p class="font-medium">
            Some pages failed to merge — retrying will re-attempt all of them:
          </p>
          {failedPages.value.map((f) => (
            <p key={f.filename}>
              {f.filename}: {f.error}
            </p>
          ))}
        </div>
      )}
      {error.value && <p class="text-sm text-destructive">{error.value}</p>}

      <div class="flex justify-end">
        <Button onClick={() => void handleComplete()} disabled={completing.value}>
          {completing.value ? 'Working…' : buttonLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// path prop is consumed by preact-iso's Router for route matching
export function CloseProjectView({ id }: { id?: string; path?: string }) {
  const { route } = useLocation();

  useEffect(() => {
    void refreshWorkspaces();
  }, [id]);

  const workspace = useComputed(() => workspaces.value.find((w) => w.id === id));
  const proj = useComputed(() => (id ? getProjectForWorkspace(id) : undefined));
  const status = proj.value?.project.status;

  useEffect(() => {
    if (id && proj.value && status !== 'closing') {
      route(`/workspaces/${id}`);
    }
  }, [id, status]);

  if (!workspace.value || !proj.value || status !== 'closing') {
    return (
      <Layout>
        <div class="flex items-center justify-center h-full text-muted-foreground text-sm">
          Loading…
        </div>
      </Layout>
    );
  }

  const ws = workspace.value;
  const project = proj.value.project;
  const step = deriveStep(project);

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-5 pb-3 border-b border-border">
          <nav class="flex items-center gap-1 text-xs text-muted-foreground mb-3">
            <a href="/workspaces" class="hover:text-foreground transition-colors">
              Workspaces
            </a>
            <ChevronRight class="size-3" />
            <a href={`/workspaces/${ws.id}`} class="hover:text-foreground transition-colors">
              {ws.name}
            </a>
            <ChevronRight class="size-3" />
            <span class="text-foreground font-medium">Close</span>
          </nav>
          <h1 class="text-lg font-semibold">
            {project.closeIntent === 'abandon' ? 'Abandoning' : 'Closing'} "{ws.name}"
          </h1>
        </div>

        <div class="flex flex-1 min-h-0">
          <div class="w-56 shrink-0 border-r border-border p-4">
            <StepIndicator current={step} />
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto">
            {step === 1 && <SnapshotStep workspaceId={ws.id} />}
            {step === 2 && <MergeStep workspace={ws} />}
            {step === 3 && <CleanupStep workspace={ws} />}
            {step === 4 && <ReviewStep workspace={ws} project={project} />}
          </div>
        </div>
      </div>
    </Layout>
  );
}
