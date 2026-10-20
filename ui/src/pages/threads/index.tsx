import { useEffect } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { FolderOpen, Search, Archive, ArchiveRestore } from 'lucide-preact';

import { Layout } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CardBadge } from '@/components/card-badge';
import { ThreadReportButton } from '@/components/thread-report-button';
import {
  allThreads,
  fetchAllThreads,
  archiveThread,
  unarchiveThread,
  type ThreadSummary,
  type ThreadType,
} from '@/hooks/use-thread';
import { useTitle } from '@/hooks/use-title';
import { cn, formatRelativeTime } from '@/lib/utils';

// 'archived' is a status filter on top of type, not a ThreadType — an
// archived thread keeps its original type, it just also carries a
// non-null archivedAt (see GLOSSARY.md "Archived Thread").
type FilterTab = 'all' | ThreadType | 'archived';

const FILTER_TABS: FilterTab[] = ['all', 'chat', 'wiki', 'workspace-chat', 'task', 'archived'];

const TYPE_LABEL: Record<FilterTab, string> = {
  all: 'All',
  chat: 'Chat',
  wiki: 'Wiki',
  'workspace-chat': 'Workspace',
  task: 'Task run',
  archived: 'Archived',
};

function matchesFilter(thread: ThreadSummary, filter: FilterTab, query: string): boolean {
  if (query && !thread.title.toLowerCase().includes(query)) return false;
  if (filter === 'archived') return thread.archivedAt != null;
  if (filter !== 'all' && thread.type !== filter) return false;
  return true;
}

// path prop is consumed by preact-iso's Router for route matching
export function ThreadsView(_props: { path?: string }) {
  useTitle('Threads');
  const filter = useSignal<FilterTab>('all');
  const search = useSignal('');

  useEffect(() => {
    void fetchAllThreads();
  }, []);

  const filtered = useComputed(() => {
    const q = search.value.toLowerCase();
    return allThreads.value.filter((t) => matchesFilter(t, filter.value, q));
  });

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-6 pb-4">
          <div class="flex items-start justify-between gap-4 mb-4">
            <div>
              <h1 class="text-xl font-semibold">Threads</h1>
              <p class="text-sm text-muted-foreground mt-0.5">
                {allThreads.value.length} thread{allThreads.value.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-3 mb-4">
            <div class="flex items-center gap-1 border border-border rounded-lg overflow-hidden text-sm">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    filter.value = tab;
                  }}
                  class={cn(
                    'px-3 py-1.5 transition-colors',
                    filter.value === tab
                      ? 'bg-muted font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {TYPE_LABEL[tab]}
                </button>
              ))}
            </div>
            <div class="relative ml-auto">
              <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search"
                value={search.value}
                onInput={(e) => {
                  search.value = (e.target as HTMLInputElement).value;
                }}
                className="pl-8 w-52"
              />
            </div>
          </div>

          <div class="border border-border rounded-xl overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-muted/40">
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:1fr"
                  >
                    Type
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:3fr"
                  >
                    Title
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:1fr"
                  >
                    Updated
                  </th>
                  <th
                    class="px-4 py-2.5 text-left font-medium text-muted-foreground"
                    style="width:0.6fr"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.value.length === 0 && (
                  <tr>
                    <td colspan={4} class="px-4 py-10 text-center text-muted-foreground">
                      <FolderOpen class="size-8 mx-auto mb-2 opacity-40" />
                      No threads found
                    </td>
                  </tr>
                )}
                {filtered.value.map((t) => (
                  <tr
                    key={t.id}
                    data-testid="thread-row"
                    data-thread-id={t.id}
                    class="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td class="px-4 py-3">
                      <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-muted text-muted-foreground">
                        {TYPE_LABEL[t.type]}
                      </span>
                    </td>
                    <td class="px-4 py-3">
                      <a href={`/chat/${t.id}`} class="font-medium hover:underline">
                        {t.title}
                      </a>
                      {/* Shown regardless of the active filter tab, so
                          switching back to "All" still distinguishes
                          archived rows at a glance. */}
                      {t.archivedAt != null && (
                        <CardBadge variant="violet" className="ml-2">
                          Archived
                        </CardBadge>
                      )}
                    </td>
                    <td class="px-4 py-3 text-xs text-muted-foreground">
                      {formatRelativeTime(t.updatedAt)}
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex items-center gap-1">
                        <ThreadReportButton threadId={t.id} />
                        {/* Archive/Unarchive is scoped to chat threads only
                            (design doc D1) — wiki/workspace-chat/task rows
                            keep just the Report button. */}
                        {t.type === 'chat' &&
                          (t.archivedAt != null ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              title="Unarchive"
                              onClick={() => void unarchiveThread(t.id)}
                            >
                              <ArchiveRestore class="size-3.5" />
                              Unarchive
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="xs"
                              title="Archive"
                              onClick={() => void archiveThread(t.id)}
                            >
                              <Archive class="size-3.5" />
                              Archive
                            </Button>
                          ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
