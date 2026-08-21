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
}

export interface AuthField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
}

export interface TrackerAdapter {
  type: string;
  displayName: string;
  icon: string; // inline SVG string
  authSchema: AuthField[];

  canCreate: boolean; // set at registration time based on config/token presence

  resolveUrl(url: string): Promise<TrackerItem>;
  getItem(id: string): Promise<TrackerItem>;
  createItem(params: { title: string; body?: string; repo?: string }): Promise<TrackerItem>;
  updateState(id: string, state: CanonicalState): Promise<TrackerItem>;
}
