import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { BookOpen, Plus, FileText, Loader2 } from 'lucide-preact';
import type { RefObject } from 'preact';
import { Markdown } from '@/components/markdown';
import {
  domains,
  activeDomainId,
  pageList,
  activePage,
  loadPage,
  refreshPages,
} from '@/hooks/use-wiki';
import { fetchPage } from '@/services/wiki-api';
import { sendWikiMessage } from '@/hooks/use-wiki-ingestion';
import { PAGE_TYPE_ICON, PAGE_TYPE_LABELS } from './page-type-icons';

const METADATA_FILES = [
  { path: 'SCHEMA.md', title: 'Schema' },
  { path: 'index.md', title: 'Index' },
  { path: 'log.md', title: 'Log' },
] as const;

const CONTENT_PAGE_TYPES = ['entity', 'concept', 'comparison', 'query', 'summary'] as const;

interface NewPageFormProps {
  domainId: string;
  onClose: () => void;
}

function NewPageForm({ domainId, onClose }: NewPageFormProps) {
  const title = useSignal('');
  const type = useSignal<string>('entity');
  const content = useSignal('');

  function handleSubmit(e: Event) {
    e.preventDefault();
    const t = title.value.trim();
    if (!t) return;
    const body = content.value.trim();
    const msg = `Create a new ${type.value} page titled "${t}" in the "${domainId}" domain.${body ? `\n\nInitial content:\n${body}` : ''}`;
    void sendWikiMessage(msg);
    onClose();
  }

  return (
    <form
      onSubmit={handleSubmit}
      class="flex flex-col gap-2 border-b border-border bg-card p-3 text-xs"
    >
      <span class="font-medium text-foreground">New Page</span>
      <input
        type="text"
        placeholder="Title"
        value={title.value}
        onInput={(e) => (title.value = (e.target as HTMLInputElement).value)}
        class="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        required
      />
      <select
        value={type.value}
        onChange={(e) => (type.value = (e.target as HTMLSelectElement).value)}
        class="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {CONTENT_PAGE_TYPES.map((t) => (
          <option key={t} value={t}>
            {PAGE_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Initial content (optional)"
        value={content.value}
        onInput={(e) => (content.value = (e.target as HTMLTextAreaElement).value)}
        rows={3}
        class="resize-none rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          class="rounded px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded bg-primary px-2 py-1 text-primary-foreground hover:bg-primary/90"
        >
          Create
        </button>
      </div>
    </form>
  );
}

interface Props {
  chatInputRef?: RefObject<HTMLTextAreaElement>;
}

export function DocumentView({ chatInputRef }: Props) {
  const showNewPage = useSignal(false);
  const editMode = useSignal(false);
  const editContent = useSignal('');
  const metadataView = useSignal(false);
  const metadataLoading = useSignal(false);
  const metadataSections = useSignal<{ title: string; content: string }[]>([]);

  const domainId = activeDomainId.value;
  const allDomains = domains.value;
  const pages = pageList.value;
  const page = activePage.value;

  // Fetch pages whenever the active domain changes, including on initial mount.
  // Also clear the metadata view so the user lands on the normal page list.
  useEffect(() => {
    if (domainId) {
      metadataView.value = false;
      void refreshPages(domainId);
    }
  }, [domainId]);

  function handleDomainChange(e: Event) {
    activeDomainId.value = (e.target as HTMLSelectElement).value;
  }

  async function handleViewMetadata() {
    if (!domainId) return;
    metadataView.value = true;
    metadataLoading.value = true;
    const results = await Promise.allSettled(
      METADATA_FILES.map((f) => fetchPage(domainId, f.path)),
    );
    metadataSections.value = results
      .map((r, i) =>
        r.status === 'fulfilled'
          ? { title: METADATA_FILES[i]!.title as string, content: r.value.content }
          : null,
      )
      .filter((s): s is { title: string; content: string } => s !== null);
    metadataLoading.value = false;
  }

  function handlePageClick(filename: string) {
    metadataView.value = false;
    if (domainId) void loadPage(domainId, filename);
  }

  function handleEdit() {
    editContent.value = page?.content ?? '';
    editMode.value = true;
  }

  function handleSave() {
    if (!page || !domainId) return;
    const msg = `Update ${page.title}:\n\n${editContent.value}`;
    void sendWikiMessage(msg);
    editMode.value = false;
    chatInputRef?.current?.focus();
  }

  // Group pages by type
  const grouped = new Map<string, typeof pages>();
  for (const p of pages) {
    const group = grouped.get(p.type) ?? [];
    group.push(p);
    grouped.set(p.type, group);
  }

  return (
    <div class="flex h-full min-h-0">
      {/* Sidebar */}
      <div class="flex w-56 shrink-0 flex-col border-r border-border">
        {/* Domain selector */}
        <div class="border-b border-border p-2">
          <select
            value={domainId ?? ''}
            onChange={handleDomainChange}
            class="w-full rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {allDomains.length === 0 && <option value="">No domains yet</option>}
            {allDomains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </select>
        </div>

        {/* View Metadata button */}
        <div class="flex items-center border-b border-border px-2 py-1.5">
          <button
            type="button"
            onClick={() => void handleViewMetadata()}
            class={`flex items-center gap-1 rounded p-1 text-xs transition-colors ${
              metadataView.value
                ? 'bg-sidebar-accent text-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'
            }`}
          >
            <BookOpen class="size-3.5" />
            View Metadata
          </button>
        </div>

        {/* + button */}
        <div class="flex items-center border-b border-border px-2 py-1.5">
          <button
            type="button"
            onClick={() => (showNewPage.value = !showNewPage.value)}
            class="flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
          >
            <Plus class="size-3.5" />
            New page
          </button>
        </div>

        {showNewPage.value && domainId && (
          <NewPageForm domainId={domainId} onClose={() => (showNewPage.value = false)} />
        )}

        {/* Page list */}
        <div class="min-h-0 flex-1 overflow-y-auto py-1">
          {CONTENT_PAGE_TYPES.map((type) => {
            const group = grouped.get(type);
            if (!group || group.length === 0) return null;
            const Icon = PAGE_TYPE_ICON[type] ?? FileText;
            const label = PAGE_TYPE_LABELS[type] ?? type;

            return (
              <div key={type} class="mb-1">
                <div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </div>
                {group.map((p) => {
                  const isActive = page?.filename === p.filename;
                  return (
                    <button
                      key={p.filename}
                      type="button"
                      onClick={() => handlePageClick(p.filename)}
                      class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                        isActive
                          ? 'bg-sidebar-accent text-foreground'
                          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
                      }`}
                    >
                      <Icon class="size-3.5 shrink-0" />
                      <span class="truncate">{p.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {pages.length === 0 && domainId && (
            <div class="px-3 py-4 text-xs text-muted-foreground">
              No pages yet. Use the chat to add content.
            </div>
          )}
        </div>
      </div>

      {/* Editor / Metadata panel */}
      <div class="flex min-w-0 flex-1 flex-col">
        {metadataView.value ? (
          <>
            {/* Metadata header — read-only, no edit controls */}
            <div class="flex items-center border-b border-border px-4 py-2">
              <div class="flex min-w-0 flex-col gap-0.5">
                <div class="truncate font-semibold text-foreground">Wiki Metadata</div>
                {domainId && (
                  <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span class="rounded bg-muted px-1.5 py-0.5">{domainId}</span>
                    <span>read-only</span>
                  </div>
                )}
              </div>
            </div>

            {/* Metadata content */}
            <div class="min-h-0 flex-1 overflow-y-auto">
              {metadataLoading.value ? (
                <div class="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 class="size-4 animate-spin" />
                </div>
              ) : (
                <div class="divide-y divide-border">
                  {metadataSections.value.map((section) => (
                    <div key={section.title} class="px-4 py-3">
                      <h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.title}
                      </h2>
                      <Markdown className="text-sm">{section.content}</Markdown>
                    </div>
                  ))}
                  {metadataSections.value.length === 0 && (
                    <div class="px-4 py-8 text-center text-sm text-muted-foreground">
                      No metadata files found.
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : page ? (
          <>
            {/* Header */}
            <div class="flex items-center justify-between border-b border-border px-4 py-2">
              <div class="flex min-w-0 flex-col gap-0.5">
                <div class="truncate font-semibold text-foreground">{page.title}</div>
                <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span class="rounded bg-muted px-1.5 py-0.5">{page.type}</span>
                  {domainId && <span>{domainId}</span>}
                  {page.frontmatter.confidence && (
                    <span class="rounded bg-muted px-1.5 py-0.5">
                      {String(page.frontmatter.confidence)}
                    </span>
                  )}
                </div>
              </div>

              <div class="flex shrink-0 items-center gap-2 pl-2">
                <div class="flex rounded border border-border text-xs">
                  <button
                    type="button"
                    onClick={() => (editMode.value = false)}
                    class={`px-2.5 py-1 transition-colors ${!editMode.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    class={`px-2.5 py-1 transition-colors ${editMode.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Edit
                  </button>
                </div>
                {editMode.value && (
                  <button
                    type="button"
                    onClick={handleSave}
                    class="rounded bg-primary px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Save
                  </button>
                )}
              </div>
            </div>

            {/* Content */}
            <div class="min-h-0 flex-1 overflow-y-auto">
              {editMode.value ? (
                <textarea
                  value={editContent.value}
                  onInput={(e) => (editContent.value = (e.target as HTMLTextAreaElement).value)}
                  class="h-full w-full resize-none border-0 bg-background p-4 font-mono text-sm text-foreground focus:outline-none"
                  spellcheck={false}
                />
              ) : (
                <Markdown className="p-4">{page.content}</Markdown>
              )}
            </div>
          </>
        ) : (
          <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a page from the sidebar
          </div>
        )}
      </div>
    </div>
  );
}
