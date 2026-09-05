import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

import {
  writeFileDirect,
  initGitRepo,
  commitAll,
  writeBinaryFile,
  writeImageFile,
  writeAudioFile,
  writeVideoFile,
  writeUnsupportedExtensionFile,
  makeReadOnly,
  removeWorkspaceDir,
} from '../lib/workspace-files.js';

// Every workspace this suite creates, so test.afterAll (below) can remove
// its on-disk directory — DELETE /api/v1/workspaces/:id only deletes the DB
// rows, it never touches the filesystem (confirmed in prior research).
const createdLocations: string[] = [];

interface CreatedWorkspace {
  id: string;
  location: string;
}

// Populated by step 5, read by the later steps that reuse the same
// workspace (all steps in a suiteRunner() suite share one page/session, so
// this mirrors how 002-GitHubTrackerWorkflow.spec.ts threads state —
// createdIssueUrl/createdIssueNumber — between its own steps).
let editWorkspace: CreatedWorkspace | null = null;

// Populated by the media-preview steps, read by the mute-toggle step that
// reuses the same workspace/tabs.
let mediaWorkspace: CreatedWorkspace | null = null;

async function createWorkspace(
  page: Page,
  data: Record<string, unknown>,
): Promise<CreatedWorkspace> {
  const res = await page.request.post('/api/v1/workspaces', { data });
  expect(res.status()).toBe(201);
  const ws = (await res.json()) as { id: string; location: string };
  createdLocations.push(ws.location);
  return { id: ws.id, location: ws.location };
}

async function openFilesTab(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: 'Files' }).click();
  await expect(page.getByTestId('file-tree')).toBeVisible();
}

function fileRow(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-tree-row"][data-path="${relativePath}"]`);
}

function fileTab(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-tab"][data-path="${relativePath}"]`);
}

function editorPane(page: Page, relativePath: string): Locator {
  return page.locator(`[data-testid="file-editor-pane"][data-path="${relativePath}"]`);
}

// Focuses the CodeMirror editor for the given (already-open, already-active)
// tab, selects the whole document (CodeMirror's default keymap binds Mod-a
// to selectAll), and types `text` in its place — a full-document replace is
// deterministic to assert on afterwards, unlike appending at an unknown
// cursor position.
async function replaceEditorContent(page: Page, relativePath: string, text: string): Promise<void> {
  const content = editorPane(page, relativePath).locator('.cm-content');
  await content.click();
  await content.press('Control+a');
  await content.pressSequentially(text);
}

function currentBranch(location: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd: location }).toString().trim();
}

export const WorkspaceFileBrowser: TestSuite = {
  id: 18,
  name: 'Workspace File Browser',
  purpose:
    'Verify the Files tab end-to-end against a real filesystem and real git repos: tree loading with git status badges, expand/collapse persistence, error states for a missing directory and a non-git workspace, multi-tab open/edit/save/discard, the dirty-close confirm guard, binary-file blocking, a genuine disk-level save failure, the tree refresh control, and image/audio/video preview with its tree warning badges and mute toggle.',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  steps: [
    {
      tag: [TAGS.Smoke],
      action:
        'Open the Files tab on a git-enabled workspace with a modified tracked file and an untracked file',
      expectedOutcome:
        'The tree loads; the header shows "git · <branch>"; the modified file shows an M badge and the untracked file shows an A badge',
      test: async ({ page }, testInfo) => {
        // This suite's 12 steps do real git/filesystem setup, real network
        // round trips, and (in the last step) a bounded refresh-retry loop
        // on top of every step's own video-pacing pause — comfortably more
        // real wall-clock time than the default per-test budget, even with
        // recordVideo's own 3x test.slow() multiplier. test.setTimeout()
        // extends the one enclosing test() this whole suite runs inside
        // (suiteRunner registers exactly one test() per suite; see its own
        // comment on why steps share a single test rather than one each).
        test.setTimeout(240_000);

        const ws = await createWorkspace(page, {
          name: `fb-git-tree-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `fb-git-tree-${Date.now()}`,
          git: true,
        });

        // Real git setup on the real workspace directory — commit a
        // baseline (README.md + a nested src/module.txt), then make an
        // uncommitted modification to README.md and add a new untracked
        // file, so the tree has exactly one M and one A to show.
        initGitRepo(ws.location);
        await writeFileDirect(ws.location, 'README.md', 'line one\n');
        await writeFileDirect(ws.location, 'src/module.txt', 'export const x = 1;\n');
        commitAll(ws.location, 'baseline');

        await writeFileDirect(ws.location, 'README.md', 'line one\nline two\n');
        await writeFileDirect(ws.location, 'notes.txt', 'temp notes\n');

        const branch = currentBranch(ws.location);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await expect(page.getByTestId('file-tree-branch')).toHaveText(`git · ${branch}`);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await expect(fileRow(page, 'README.md')).toBeVisible();
        await expect(
          fileRow(page, 'README.md').locator('[data-testid="file-tree-status"]'),
        ).toHaveText('M');
        await expect(
          fileRow(page, 'notes.txt').locator('[data-testid="file-tree-status"]'),
        ).toHaveText('A');

        // src/ is a real nested directory — collapsed by default (step 2
        // reuses this same workspace to test expand/collapse).
        await expect(fileRow(page, 'src')).toBeVisible();
        await expect(fileRow(page, 'src/module.txt')).not.toBeVisible();
      },
    },
    {
      action: 'Expand a folder, then switch to another top-level tab and back',
      expectedOutcome:
        'The folder expands to show its children; the expanded state survives navigating away to another tab and back, without re-clicking the folder',
      test: async ({ page }, testInfo) => {
        // Reuses the previous step's already-open Files tab/tree — same
        // page, same workspace, matching how a real user would keep working
        // in the tab they already have open.
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'src').click();
        await expect(fileRow(page, 'src/module.txt')).toBeVisible();

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await page.getByRole('button', { name: 'Overview' }).click();
        await expect(page.getByTestId('file-tree')).not.toBeVisible();

        await page.getByRole('button', { name: 'Files' }).click();
        await expect(page.getByTestId('file-tree')).toBeVisible();

        // Expansion is module-level state in the hook, not tied to the
        // FilesTab component's own mount lifecycle — it should still be
        // expanded without clicking "src" again.
        await expect(fileRow(page, 'src/module.txt')).toBeVisible();
      },
    },
    {
      action: 'Point a workspace at a directory that no longer exists on disk, then open Files',
      expectedOutcome: 'The tree panel shows a clear error state instead of crashing',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(page, {
          name: `fb-missing-dir-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `fb-missing-dir-${Date.now()}`,
        });

        // Delete the workspace's own directory out from under it — the API
        // created it on workspace creation, so this genuinely reproduces
        // "directory missing/unreadable" rather than simulating it.
        await removeWorkspaceDir(ws.location);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await page.goto(`/workspaces/${ws.id}`);
        await page.getByRole('button', { name: 'Files' }).click();

        await expect(page.getByTestId('file-tree-error')).toBeVisible();
        await expect(page.locator('[data-testid="file-tree-row"]')).toHaveCount(0);

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Open a workspace with git: false',
      expectedOutcome:
        'The tree loads fully with no branch label in the header and no status badges on any file',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(page, {
          name: `fb-no-git-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `fb-no-git-${Date.now()}`,
          git: false,
        });
        await writeFileDirect(ws.location, 'readme.txt', 'plain workspace, no git\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await expect(page.getByTestId('file-tree-branch')).toHaveText('');
        await expect(fileRow(page, 'readme.txt')).toBeVisible();
        await expect(page.locator('[data-testid="file-tree-status"]')).toHaveCount(0);

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Click a file, then a second file',
      expectedOutcome:
        'Both open as tabs in the tab bar; the correct content is shown for whichever tab is active',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(page, {
          name: `fb-edit-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `fb-edit-${Date.now()}`,
          git: true,
        });

        initGitRepo(ws.location);
        await writeFileDirect(ws.location, 'alpha.txt', 'Alpha content\n');
        await writeFileDirect(ws.location, 'beta.txt', 'Beta content\n');
        await writeFileDirect(ws.location, 'locked.txt', 'Locked content\n');
        await writeBinaryFile(ws.location, 'image.bin');
        commitAll(ws.location, 'baseline');

        editWorkspace = ws;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await fileRow(page, 'alpha.txt').click();
        await expect(fileTab(page, 'alpha.txt')).toBeVisible();
        await expect(editorPane(page, 'alpha.txt').locator('.cm-content')).toContainText(
          'Alpha content',
        );

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'beta.txt').click();
        await expect(fileTab(page, 'beta.txt')).toBeVisible();
        await expect(editorPane(page, 'beta.txt').locator('.cm-content')).toContainText(
          'Beta content',
        );

        // Both tabs are present in the bar at once.
        await expect(page.locator('[data-testid="file-tab"]')).toHaveCount(2);

        // Switching back to the first tab shows its own content again.
        await fileTab(page, 'alpha.txt').click();
        await expect(editorPane(page, 'alpha.txt').locator('.cm-content')).toContainText(
          'Alpha content',
        );
      },
    },
    {
      action: 'Edit the open alpha.txt tab',
      expectedOutcome: 'An unsaved-dot appears on the alpha.txt tab only — beta.txt is unaffected',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'alpha.txt').click();
        await replaceEditorContent(page, 'alpha.txt', 'Alpha content\nEdited by e2e test\n');

        await expect(
          fileTab(page, 'alpha.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();
        await expect(
          fileTab(page, 'beta.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).not.toBeVisible();
      },
    },
    {
      tag: [TAGS.Smoke],
      action: 'Click Save on the dirty alpha.txt tab',
      expectedOutcome:
        'Content is actually written to disk; the unsaved-dot clears; the tree status badge for alpha.txt updates to M',
      test: async ({ page }, testInfo) => {
        const ws = editWorkspace as CreatedWorkspace;

        // No M badge yet — alpha.txt matches the committed baseline.
        await expect(editorPane(page, 'alpha.txt')).toBeVisible();
        await expect(
          fileRow(page, 'alpha.txt').locator('[data-testid="file-tree-status"]'),
        ).toHaveCount(0);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await editorPane(page, 'alpha.txt').getByRole('button', { name: 'Save' }).click();

        await expect(
          fileTab(page, 'alpha.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).not.toBeVisible();

        const onDisk = await readFile(`${ws.location}/alpha.txt`, 'utf8');
        expect(onDisk).toBe('Alpha content\nEdited by e2e test\n');

        // Save triggers a force tree refresh — the badge should now show M.
        await expect(
          fileRow(page, 'alpha.txt').locator('[data-testid="file-tree-status"]'),
        ).toHaveText('M');
      },
    },
    {
      action: 'Edit beta.txt, then click Discard',
      expectedOutcome: 'The buffer reverts to the last-saved content; nothing is written to disk',
      test: async ({ page }, testInfo) => {
        const ws = editWorkspace as CreatedWorkspace;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'beta.txt').click();
        await replaceEditorContent(page, 'beta.txt', 'Something else entirely\n');
        await expect(
          fileTab(page, 'beta.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await editorPane(page, 'beta.txt').getByRole('button', { name: 'Discard' }).click();

        await expect(
          fileTab(page, 'beta.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).not.toBeVisible();
        await expect(editorPane(page, 'beta.txt').locator('.cm-content')).toHaveText(
          'Beta content\n',
        );

        const onDisk = await readFile(`${ws.location}/beta.txt`, 'utf8');
        expect(onDisk).toBe('Beta content\n');
      },
    },
    {
      action: 'Edit beta.txt again, then attempt to close its tab',
      expectedOutcome:
        'A confirmation prompt appears before the tab actually closes — dismissing it keeps the tab open, accepting it closes the tab',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'beta.txt').click();
        await replaceEditorContent(page, 'beta.txt', 'temp edit for the close guard\n');
        await expect(
          fileTab(page, 'beta.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();

        // Dismiss first — proves the guard actually blocks the close, not
        // just that a dialog appears. Scoped to the tab itself (rather than
        // the whole page) and `exact: true`, since the tab button's own
        // accessible name also contains "Close beta.txt" via its nested
        // close control.
        const closeButton = fileTab(page, 'beta.txt').getByRole('button', {
          name: 'Close beta.txt',
          exact: true,
        });
        page.once('dialog', (d) => d.dismiss());
        await closeButton.click();
        await expect(fileTab(page, 'beta.txt')).toBeVisible();

        // Now accept — the tab should actually close.
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        page.once('dialog', (d) => d.accept());
        await closeButton.click();
        await expect(fileTab(page, 'beta.txt')).not.toBeVisible();
      },
    },
    {
      action: 'Click the binary image.bin file in the tree',
      expectedOutcome: '"Can\'t display this file" is shown instead of a tab with content',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'image.bin').click();

        await expect(fileTab(page, 'image.bin')).toBeVisible();
        await expect(editorPane(page, 'image.bin').getByTestId('file-unsupported')).toHaveText(
          "Can't display this file.",
        );
        await expect(editorPane(page, 'image.bin').locator('.cm-content')).toHaveCount(0);
      },
    },
    {
      action: 'Make locked.txt read-only on disk, edit it, then click Save',
      expectedOutcome:
        'An inline error is shown; the edited buffer is preserved (not reverted or lost), and nothing changes on disk',
      test: async ({ page }, testInfo) => {
        const ws = editWorkspace as CreatedWorkspace;

        await makeReadOnly(ws.location, 'locked.txt');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'locked.txt').click();
        await expect(editorPane(page, 'locked.txt').locator('.cm-content')).toContainText(
          'Locked content',
        );

        await replaceEditorContent(page, 'locked.txt', 'Attempted edit\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await editorPane(page, 'locked.txt').getByRole('button', { name: 'Save' }).click();

        await expect(editorPane(page, 'locked.txt').getByTestId('file-editor-error')).toBeVisible();
        // Dirty state and the edited buffer are both preserved — the save
        // failure must not revert or discard the in-progress edit.
        await expect(
          fileTab(page, 'locked.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();
        await expect(editorPane(page, 'locked.txt').locator('.cm-content')).toHaveText(
          'Attempted edit\n',
        );

        const onDisk = await readFile(`${ws.location}/locked.txt`, 'utf8');
        expect(onDisk).toBe('Locked content\n');
      },
    },
    {
      action: 'Edit a file directly on disk (bypassing the app), then use the tree refresh control',
      expectedOutcome:
        'The refresh control eventually surfaces the change once the server-side cache accepts a fresh read',
      test: async ({ page }, testInfo) => {
        const ws = editWorkspace as CreatedWorkspace;

        await writeFileDirect(ws.location, 'gamma.txt', 'created directly on disk\n');

        const refreshButton = page.getByRole('button', { name: 'Refresh file tree' });
        const gammaRow = fileRow(page, 'gamma.txt');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        // The server caches the tree for 15s (workspace-files.ts's
        // CACHE_TTL_MS) and a direct-to-disk write never invalidates that
        // cache (only this workspace's own PATCH does) — so the exact
        // moment the change becomes visible depends on how much of that
        // window has already elapsed by the time this step runs. Rather
        // than asserting a specific staleness window (a real 15s wait would
        // make this brittle against actual TTL boundaries), this repeatedly
        // clicks the real refresh control and polls the real API until the
        // server's cache naturally expires and re-walks the directory —
        // proving the refresh control itself does its job.
        await expect(async () => {
          await refreshButton.click();
          await expect(gammaRow).toBeVisible({ timeout: 500 });
        }).toPass({ timeout: 20_000, intervals: [1000] });

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      tag: [TAGS.Smoke],
      action:
        'Open the Files tab on a workspace with one file of each media category plus an oversized text file',
      expectedOutcome:
        'The tree loads; the unsupported-extension file shows the amber unsupported badge, and the oversized text file shows the distinct oversize badge',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(page, {
          name: `fb-media-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `fb-media-${Date.now()}`,
          git: false,
        });

        await writeImageFile(ws.location, 'image.png');
        await writeAudioFile(ws.location, 'audio.mp3');
        await writeVideoFile(ws.location, 'video.mp4');
        await writeUnsupportedExtensionFile(ws.location, 'archive.zip');
        await writeFileDirect(ws.location, 'huge.txt', 'a'.repeat(2 * 1024 * 1024 + 1));

        mediaWorkspace = ws;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await expect(
          fileRow(page, 'archive.zip').locator('[data-testid="file-tree-unsupported"]'),
        ).toBeVisible();
        await expect(
          fileRow(page, 'huge.txt').locator('[data-testid="file-tree-oversize"]'),
        ).toBeVisible();
      },
    },
    {
      action: 'Click the image file',
      expectedOutcome:
        'The tab shows an <img> with the file\'s content instead of the CodeMirror editor',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'image.png').click();

        await expect(fileTab(page, 'image.png')).toBeVisible();
        const img = editorPane(page, 'image.png').getByTestId('file-image');
        await expect(img).toBeVisible();
        await expect(img).toHaveAttribute('src', /\/image\.png\/content$/);
        await expect(editorPane(page, 'image.png').locator('.cm-content')).toHaveCount(0);
      },
    },
    {
      action: 'Click the audio file, then the video file',
      expectedOutcome:
        'Both open as native players with playback controls, and both tabs remain in the tab bar together',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'audio.mp3').click();
        await expect(fileTab(page, 'audio.mp3')).toBeVisible();
        const audio = editorPane(page, 'audio.mp3').getByTestId('file-audio');
        await expect(audio).toBeVisible();
        await expect(audio).toHaveAttribute('controls', '');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'video.mp4').click();
        await expect(fileTab(page, 'video.mp4')).toBeVisible();
        const video = editorPane(page, 'video.mp4').getByTestId('file-video');
        await expect(video).toBeVisible();
        await expect(video).toHaveAttribute('controls', '');

        await expect(fileTab(page, 'audio.mp3')).toBeVisible();
        await expect(fileTab(page, 'video.mp4')).toBeVisible();
      },
    },
    {
      action: 'Click the unsupported archive.zip file',
      expectedOutcome: '"Can\'t display this file" is shown, same as any other unsupported file',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'archive.zip').click();

        await expect(fileTab(page, 'archive.zip')).toBeVisible();
        await expect(editorPane(page, 'archive.zip').getByTestId('file-unsupported')).toHaveText(
          "Can't display this file.",
        );
        await expect(editorPane(page, 'archive.zip').locator('.cm-content')).toHaveCount(0);
      },
    },
    {
      action: 'Click the oversized huge.txt file',
      expectedOutcome:
        'Its tree row keeps showing the oversize badge, and opening it falls back to the same "Can\'t display this file" message — the badge only warns in advance, the real 422-too-large path is unchanged',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'huge.txt').click();

        await expect(fileTab(page, 'huge.txt')).toBeVisible();
        await expect(editorPane(page, 'huge.txt').getByTestId('file-unsupported')).toHaveText(
          "Can't display this file.",
        );
        await expect(
          fileRow(page, 'huge.txt').locator('[data-testid="file-tree-oversize"]'),
        ).toBeVisible();
      },
    },
    {
      action: 'Toggle mute, then switch between the audio and video tabs',
      expectedOutcome:
        'Before toggling, only the inactive tab is muted; after toggling, both tabs report muted regardless of which is active',
      test: async ({ page }, testInfo) => {
        const ws = mediaWorkspace as CreatedWorkspace;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'video.mp4').click();
        const video = editorPane(page, 'video.mp4').getByTestId('file-video');
        const audio = editorPane(page, 'audio.mp3').getByTestId('file-audio');

        // Preact sets `muted` as a live JS property, not a reflected HTML
        // attribute — assert via the DOM property, not toHaveAttribute.
        expect(await video.evaluate((el: HTMLMediaElement) => el.muted)).toBe(false);
        expect(await audio.evaluate((el: HTMLMediaElement) => el.muted)).toBe(true);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await editorPane(page, 'video.mp4').getByTestId('media-mute-toggle').click();

        expect(await video.evaluate((el: HTMLMediaElement) => el.muted)).toBe(true);
        expect(await audio.evaluate((el: HTMLMediaElement) => el.muted)).toBe(true);

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
  ],
};

test.afterAll(async () => {
  for (const location of createdLocations) {
    await removeWorkspaceDir(location);
  }
});

suiteRunner(WorkspaceFileBrowser);
