import { isManagedLocation, managedRoots } from '../../services/workspace-location.js';

// API-facing shape of a workspace: the store's DB-shaped row plus whether its
// directory lives under a managed root. The UI needs `managedLocation` before
// a delete to tell the user honestly whether the files on disk will go too.
export type WorkspaceResponse<T extends { location: string }> = T & { managedLocation: boolean };

export function toWorkspaceResponse<T extends { location: string }>(
  ws: T,
  roots: string[] = managedRoots(),
): WorkspaceResponse<T> {
  return { ...ws, managedLocation: isManagedLocation(ws.location, roots) };
}
