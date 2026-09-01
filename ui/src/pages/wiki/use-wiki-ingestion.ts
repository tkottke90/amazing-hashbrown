import { signal, computed } from '@preact/signals';
import { randomUUID } from '@/lib/utils';
import {
  useThreadInstance,
  type ThreadInstance,
  type ThreadInstanceOptions,
} from '@/hooks/use-thread';
import {
  activeDomainId,
  refreshDomains,
  refreshGraph,
  refreshPages,
  loadPage,
  activePagePath,
} from './use-wiki';

// ---- Persistent thread ID ----
// Wiki chat is a single, persistent, globally-current thread — unlike the
// global chat's sidebar-driven thread list or a workspace's own per-workspace
// thread, there is exactly one "current" wiki conversation at a time, named
// by this signal and swapped out wholesale by newWikiThread() below.

const WIKI_THREAD_KEY = 'ah-wiki-thread-id';

function readStoredWikiThreadId(): string {
  try {
    return localStorage.getItem(WIKI_THREAD_KEY) ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

function persistWikiThreadId(id: string): void {
  try {
    localStorage.setItem(WIKI_THREAD_KEY, id);
  } catch {
    // best-effort only
  }
}

export const wikiThreadId = signal<string>(readStoredWikiThreadId());
persistWikiThreadId(wikiThreadId.value);

// ---- Wiki-only side-effect state ----
// Set via the onWikiOriented callback below rather than a switch case of its
// own — useThreadInstance() is shared with global/workspace chat, which have
// no notion of "oriented to a wiki", so this stays wiki-chat-local state.
export const wikiOrientedTo = signal<string | null>(null);

// Same options every time a ThreadInstance is resolved for a given wiki
// thread id — used by both currentWikiThread() and hydrateWikiThread() so
// whichever happens to run first (render order isn't guaranteed) builds the
// instance with these wiki side effects wired in, not a bare default one
// (useThreadInstance() memoizes per id and ignores opts on a cache hit).
function wikiThreadOpts(id: string): ThreadInstanceOptions {
  return {
    endpointBase: '/api/v1/wiki/chat',
    readUrl: `/api/v1/threads/${id}`,
    onWikiUpdated: () => {
      // Refresh the graph and page list on any wiki update, reloading the
      // active page if it was the one just modified.
      void refreshGraph();
      const domainId = activeDomainId.value;
      if (domainId) {
        void refreshPages(domainId).then(() => {
          const pagePath = activePagePath.value;
          if (pagePath) void loadPage(domainId, pagePath);
        });
      }
    },
    onWikiOriented: (evt) => {
      wikiOrientedTo.value = evt.wikiId;
    },
    onWikiDomainCreated: () => {
      void refreshDomains();
      void refreshGraph();
    },
  };
}

function currentWikiThread(): ThreadInstance {
  return useThreadInstance(wikiThreadId.value, wikiThreadOpts(wikiThreadId.value));
}

// ---- Public reactive state ----
// Computed rather than plain signals so each always reflects whichever
// thread id is current — newWikiThread() below just points wikiThreadId at
// a fresh id, and useThreadInstance() memoizing per id means that fresh id
// naturally starts out empty with no manual reset needed.

export const wikiMessages = computed(() => currentWikiThread().messages.value);
export const wikiDisplayMessages = computed(() => currentWikiThread().displayMessages.value);
export const wikiIsStreaming = computed(() => currentWikiThread().isStreaming.value);
export const wikiPendingHitlId = computed(() => currentWikiThread().pendingHitlId.value);
export const activeWikiModel = computed(() => currentWikiThread().activeThreadModel.value);

// ---- Public actions ----

export function setWikiModel(provider: string, model: string): void {
  currentWikiThread().setThreadModel(provider, model);
}

export async function hydrateWikiThread(id: string): Promise<void> {
  await useThreadInstance(id, wikiThreadOpts(id)).hydrate();
}

export async function sendWikiMessage(content: string): Promise<void> {
  await currentWikiThread().sendMessage(content);
}

export async function submitWikiHitlAnswer(promptId: string, answer: string): Promise<void> {
  await currentWikiThread().submitHitlAnswer(promptId, answer);
}

export function stopWikiGeneration(): void {
  currentWikiThread().stopGeneration();
}

export async function retryWikiTurn(): Promise<void> {
  await currentWikiThread().retryTurn();
}

export function newWikiThread(): void {
  const thread = currentWikiThread();
  if (thread.isStreaming.value) thread.stopGeneration();
  const id = randomUUID();
  wikiThreadId.value = id;
  persistWikiThreadId(id);
  wikiOrientedTo.value = null;
}
