export type DetailTab = 'overview' | 'tasks' | 'files' | 'chat';

export const DETAIL_TAB_TITLE_SUFFIX: Record<DetailTab, string> = {
  overview: '',
  tasks: ' - Kanban',
  files: ' - Files',
  chat: ' - Chat',
};

export const DETAIL_TABS: DetailTab[] = ['overview', 'tasks', 'files', 'chat'];
