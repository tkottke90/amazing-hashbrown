// Plugin interface for external issue-tracker integrations (GitHub, Todoist,
// Linear, ...). Built-in adapters (see ../adapters/) and external packages
// listed in TRACKER_PLUGINS both implement this same shape and register with
// the TrackerRegistry (./tracker-registry.ts).

export type CanonicalState = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface TrackerItem {
  id: string; // internal id, e.g. "owner/repo#123"
  url: string;
  title: string;
  state: CanonicalState;
  trackerState: string; // raw state string from the external system
  dueAt: string | null; // YYYY-MM-DD; null when the tracker has no due date for this item
}

// Who a hashbrown task is assigned to — mapped by each adapter onto its own
// representation (e.g. Todoist's Assignee Labels). See GLOSSARY.md.
export type Assignee = 'user' | 'agent' | null;

// A place a newly created item can land in: a GitHub repository, a Todoist
// project. See GLOSSARY.md "Tracker Container".
export interface TrackerContainer {
  id: string;
  name: string;
}

export interface CreateTrackerItemParams {
  title: string;
  body?: string;
  container?: string; // Tracker Container id; adapter default when omitted
  dueAt?: string | null; // YYYY-MM-DD
}

export interface AuthField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  // When true, the Settings UI renders this field with the literal-value/
  // environment-variable-reference toggle (CredentialValueField) instead
  // of a plain input — see docs/superpowers/specs/2026-10-05-git-credentials-design.md.
  supportsEnvRef?: boolean;
}

export interface TrackerAdapter {
  type: string;
  displayName: string;
  icon: string; // inline SVG string
  authSchema: AuthField[];

  canCreate: boolean; // set at registration time based on config/token presence
  // Whether the adapter has what it needs to answer requests at all (e.g. a
  // required token). Every built-in adapter is always registered so Settings
  // can configure it; only configured adapters are offered for linking.
  configured: boolean;

  resolveUrl(url: string): Promise<TrackerItem>;
  getItem(id: string): Promise<TrackerItem>;
  createItem(params: CreateTrackerItemParams): Promise<TrackerItem>;
  updateState(id: string, state: CanonicalState): Promise<TrackerItem>;
  // Optional: list the Tracker Containers a new item can be created in.
  listContainers?(): Promise<TrackerContainer[]>;
  // Optional: reflect a hashbrown task's assignee onto the linked item.
  setAssignee?(id: string, assignee: Assignee): Promise<void>;
}
