import { APIRequestContext, Locator, Page, expect } from '@playwright/test';

export interface CreatedWorkspace {
  id: string;
  location: string;
}

export async function createWorkspace(
  request: APIRequestContext,
  data: Record<string, unknown>,
  createdLocations: string[],
): Promise<CreatedWorkspace> {
  const res = await request.post('/api/v1/workspaces', { data });
  expect(res.status()).toBe(201);
  const ws = (await res.json()) as { id: string; location: string };
  createdLocations.push(ws.location);
  return { id: ws.id, location: ws.location };
}

export async function deleteWorkspace(
  request: APIRequestContext,
  workspaceId: string,
): Promise<void> {
  const res = await request.delete(`/api/v1/workspaces/${workspaceId}`);
  expect(res.status()).toBe(200);
  // Workspaces created through the API always live under a managed root, so
  // their directory must be gone after the delete (issue #204).
  expect((await res.json()).directory.removed).toBe(true);
}

export async function openFilesTab(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(page.getByTestId('file-tree')).toBeVisible();
}

export function fileRow(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-tree-row"][data-path="${relativePath}"]`);
}

export function fileTab(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-tab"][data-path="${relativePath}"]`);
}

export function editorPane(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-editor-pane"][data-path="${relativePath}"]`);
}
