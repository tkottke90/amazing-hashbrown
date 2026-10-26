import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
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
import { CreateTask } from './workspace/CreateTasks.js';
import { CreateScheduledTasks } from './workspace/CreateScheduledTasks.js';
import { CronAbortWatch } from './workspace/CronAbortWatch.js';
import { CohortGating } from './workspace/CohortGating.js';
import {
  createWorkspace,
  editorPane,
  fileRow,
  fileTab,
  openFilesTab,
} from './workspace/utilities.js';

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

// Populated by the stale-file/conflict steps, read by the later steps in
// that same sequence (silent refresh -> conflict banner -> Overwrite ->
// Discard my edits -> deleted-on-disk).
let conflictWorkspace: CreatedWorkspace | null = null;

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
        // This suite's 30 steps do real git/filesystem setup, real network
        // round trips, a bounded refresh-retry loop, and (for the stale-
        // file/conflict/Agent-Resolve/delete steps) several more rounds of
        // real tab open/edit/switch/reactivate on top of every step's own
        // video-pacing pause — comfortably more real wall-clock time than
        // the default per-test budget, even with recordVideo's own 3x
        // test.slow() multiplier. test.setTimeout() extends the one
        // enclosing test() this whole suite runs inside (suiteRunner
        // registers exactly one test() per suite; see its own comment on
        // why steps share a single test rather than one each).
        test.setTimeout(420_000);

        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-git-tree-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-git-tree-${Date.now()}`,
            git: true,
          },
          createdLocations,
        );

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
        // Both the chevron and the folder name toggle expand/collapse —
        // hovering the row is what reveals its action icons instead (see
        // the upload/create steps at the end of this suite).
        await fileRow(page, 'src').getByTestId('file-tree-chevron').click();
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

        // Clicking the folder name itself (not just the chevron) toggles
        // the same expand/collapse state.
        await fileRow(page, 'src').click();
        await expect(fileRow(page, 'src/module.txt')).not.toBeVisible();

        await fileRow(page, 'src').click();
        await expect(fileRow(page, 'src/module.txt')).toBeVisible();
      },
    },
    {
      action: 'Point a workspace at a directory that no longer exists on disk, then open Files',
      expectedOutcome: 'The tree panel shows a clear error state instead of crashing',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-missing-dir-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-missing-dir-${Date.now()}`,
          },
          createdLocations,
        );

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
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-no-git-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-no-git-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
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
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-edit-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-edit-${Date.now()}`,
            git: true,
          },
          createdLocations,
        );

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
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-media-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-media-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );

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
        "The tab shows an <img> with the file's content instead of the CodeMirror editor",
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
    {
      action: 'Upload a file into the workspace root via the header upload icon',
      expectedOutcome: 'The uploaded file appears in the tree at the root without a manual refresh',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-upload-root-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-upload-root-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        // Clicking the real icon (rather than calling setInputFiles directly
        // on the hidden input) is deliberate — it's what actually exercises
        // the app setting its upload target to root before the native file
        // input opens.
        const chooserPromise = page.waitForEvent('filechooser');
        await page.getByTestId('file-tree-header').getByTestId('folder-action-upload').click();
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: 'uploaded.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello from e2e\n'),
        });

        await expect(fileRow(page, 'uploaded.txt')).toBeVisible();

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Hover a nested folder, then upload a file into it',
      expectedOutcome: 'The uploaded file appears nested under the hovered folder, not at the root',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-upload-nested-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-upload-nested-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'sub/existing.txt', 'already here\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        // Hovering a folder row is what reveals its own action icons.
        await fileRow(page, 'sub').hover();
        const chooserPromise = page.waitForEvent('filechooser');
        await fileRow(page, 'sub').getByTestId('folder-action-upload').click();
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: 'nested.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('nested content\n'),
        });

        await fileRow(page, 'sub').getByTestId('file-tree-chevron').click();
        await expect(fileRow(page, 'sub/nested.txt')).toBeVisible();
        await expect(fileRow(page, 'nested.txt')).not.toBeVisible(); // not at root

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Upload a file whose name collides with an existing one',
      expectedOutcome:
        'The upload is rejected with a visible inline error naming the conflicting file, and the existing file is left untouched',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-upload-collision-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-upload-collision-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'dup.txt', 'original content\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        const chooserPromise = page.waitForEvent('filechooser');
        await page.getByTestId('file-tree-header').getByTestId('folder-action-upload').click();
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: 'dup.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('clobbering content\n'),
        });

        await expect(page.getByTestId('upload-error')).toBeVisible();
        await expect(page.getByTestId('upload-error')).toContainText('dup.txt');
        await expect(fileRow(page, 'dup.txt')).toHaveCount(1);
        expect(await readFile(`${ws.location}/dup.txt`, 'utf8')).toBe('original content\n');

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Create a new file via the "New file" modal',
      expectedOutcome: 'The new file appears in the tree and opens as an empty tab',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-new-file-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-new-file-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await page.getByTestId('file-tree-header').getByTestId('folder-action-new-file').click();
        // The header always renders both the New File and New Folder forms,
        // so a bare getByRole('button', { name: 'Create' }) would match two
        // elements — scope to the <form> that contains this modal's own
        // input (CreateEntryForm wraps each modal's body in one <form>).
        const newFileForm = page.locator('form', {
          has: page.getByPlaceholder('File name (e.g. notes.txt)'),
        });
        await newFileForm.getByPlaceholder('File name (e.g. notes.txt)').fill('created.txt');
        await newFileForm.getByRole('button', { name: 'Create' }).click();

        await expect(fileRow(page, 'created.txt')).toBeVisible();
        await expect(fileTab(page, 'created.txt')).toBeVisible();

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Create a new folder inside a folder revealed by hover via the "New folder" modal',
      expectedOutcome:
        'The new folder appears nested under the hovered parent, and the parent is expanded to show it without needing a manual expand click',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-new-folder-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-new-folder-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'sub/existing.txt', 'already here\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        // Hovering "sub" (collapsed by default) reveals its own action
        // icons; creating a folder inside it should expand "sub" itself
        // (the parent of the new folder) — not the new folder, which is
        // empty and starts collapsed like any other fresh folder.
        await fileRow(page, 'sub').hover();
        await fileRow(page, 'sub').getByTestId('folder-action-new-folder').click();
        // Every directory row's New File/New Folder forms are always
        // mounted in the DOM (only hidden via CSS opacity until hover —
        // see file-tree.tsx), so a page-wide form/placeholder filter would
        // match one per row plus the header. Scope to the "sub" row
        // itself, which contains only its own modal's form.
        const newFolderForm = fileRow(page, 'sub').locator('form', {
          has: page.getByPlaceholder('Folder name'),
        });
        await newFolderForm.getByPlaceholder('Folder name').fill('child-folder');
        await newFolderForm.getByRole('button', { name: 'Create' }).click();

        await expect(fileRow(page, 'sub').getByTestId('file-tree-chevron')).toHaveAttribute(
          'aria-label',
          'Collapse folder',
        );
        await expect(fileRow(page, 'sub/child-folder')).toBeVisible();

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      tag: [TAGS.Smoke],
      action: 'Open two tabs, edit one of them directly on disk, then switch away and back to it',
      expectedOutcome:
        'The clean tab silently refreshes to the new on-disk content on reactivation — no banner, no manual action needed',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-conflict-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-conflict-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'stale.txt', 'version 1\n');
        await writeFileDirect(ws.location, 'other.txt', 'other content\n');
        conflictWorkspace = ws;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);

        await fileRow(page, 'stale.txt').click();
        await expect(editorPane(page, 'stale.txt').locator('.cm-content')).toHaveText(
          'version 1\n',
        );

        await fileRow(page, 'other.txt').click();
        await expect(fileTab(page, 'other.txt')).toBeVisible();

        // Edited directly on disk while the stale.txt tab sits inactive and
        // clean — this is the reported bug: reopening it used to keep
        // showing the stale, already-fetched content.
        await writeFileDirect(ws.location, 'stale.txt', 'version 2, written on disk\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'stale.txt').click();

        await expect(editorPane(page, 'stale.txt').locator('.cm-content')).toHaveText(
          'version 2, written on disk\n',
        );
        await expect(editorPane(page, 'stale.txt').getByTestId('file-conflict-banner')).toHaveCount(
          0,
        );
      },
    },
    {
      action: 'Edit the same file locally, switch away, change it on disk again, then switch back',
      expectedOutcome:
        'A conflict banner appears instead of silently overwriting the local draft, offering Overwrite / Discard my edits / Agent Resolve',
      test: async ({ page }, testInfo) => {
        const ws = conflictWorkspace as CreatedWorkspace;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'stale.txt').click();
        await replaceEditorContent(page, 'stale.txt', 'my local edit\n');
        await expect(
          fileTab(page, 'stale.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();

        await fileTab(page, 'other.txt').click();
        await writeFileDirect(ws.location, 'stale.txt', 'version 3, written on disk\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'stale.txt').click();

        const banner = editorPane(page, 'stale.txt').getByTestId('file-conflict-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('changed on disk');
        await expect(banner.getByRole('button', { name: 'Overwrite' })).toBeVisible();
        await expect(banner.getByRole('button', { name: 'Discard my edits' })).toBeVisible();
        await expect(banner.getByRole('button', { name: 'Agent Resolve' })).toBeVisible();

        // The local edit itself must survive the reactivation untouched —
        // only the banner appears, the editor content is never overwritten
        // automatically.
        await expect(editorPane(page, 'stale.txt').locator('.cm-content')).toHaveText(
          'my local edit\n',
        );
      },
    },
    {
      action: 'Click Overwrite on the conflict banner',
      expectedOutcome:
        'The local draft is written to disk despite the conflict, and the banner clears',
      test: async ({ page }, testInfo) => {
        const ws = conflictWorkspace as CreatedWorkspace;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await editorPane(page, 'stale.txt').getByRole('button', { name: 'Overwrite' }).click();

        await expect(editorPane(page, 'stale.txt').getByTestId('file-conflict-banner')).toHaveCount(
          0,
        );
        await expect(
          fileTab(page, 'stale.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).not.toBeVisible();

        const onDisk = await readFile(`${ws.location}/stale.txt`, 'utf8');
        expect(onDisk).toBe('my local edit\n');
      },
    },
    {
      action: 'Create a fresh local/disk conflict, then click "Discard my edits"',
      expectedOutcome:
        'The editor reloads the on-disk content, discarding the local draft; nothing is written',
      test: async ({ page }, testInfo) => {
        const ws = conflictWorkspace as CreatedWorkspace;

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'stale.txt').click();
        await replaceEditorContent(page, 'stale.txt', 'a second local edit\n');
        await fileTab(page, 'other.txt').click();
        await writeFileDirect(ws.location, 'stale.txt', 'version 4, written on disk\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'stale.txt').click();
        await expect(
          editorPane(page, 'stale.txt').getByTestId('file-conflict-banner'),
        ).toBeVisible();

        await editorPane(page, 'stale.txt')
          .getByRole('button', { name: 'Discard my edits' })
          .click();

        await expect(editorPane(page, 'stale.txt').getByTestId('file-conflict-banner')).toHaveCount(
          0,
        );
        await expect(editorPane(page, 'stale.txt').locator('.cm-content')).toHaveText(
          'version 4, written on disk\n',
        );
        await expect(
          fileTab(page, 'stale.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).not.toBeVisible();

        const onDisk = await readFile(`${ws.location}/stale.txt`, 'utf8');
        expect(onDisk).toBe('version 4, written on disk\n');

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Open a file, delete it directly on disk, then reactivate its clean tab',
      expectedOutcome:
        'The tab shows a "deleted on disk" state instead of silently keeping the old content',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-deleted-on-disk-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-deleted-on-disk-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'gone.txt', 'will be deleted\n');
        await writeFileDirect(ws.location, 'other.txt', 'other content\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);
        await fileRow(page, 'gone.txt').click();
        await fileRow(page, 'other.txt').click();

        await rm(`${ws.location}/gone.txt`);

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileTab(page, 'gone.txt').click();

        await expect(
          editorPane(page, 'gone.txt').getByTestId('file-deleted-on-disk'),
        ).toBeVisible();
        await editorPane(page, 'gone.txt').getByRole('button', { name: 'Close tab' }).click();
        await expect(fileTab(page, 'gone.txt')).not.toBeVisible();

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: 'Create a conflict, click Agent Resolve, and let a mocked agent turn propose a merge',
      expectedOutcome:
        "The UI switches to the Chat tab and posts the composed conflict message; once the mocked tool call resolves, the Files tab's editor shows the merged draft as a new dirty, unsaved buffer",
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-agent-resolve-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-agent-resolve-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'conflict.txt', 'original\n');

        // Per e2e/AGENTS.md's SSE-mocking guidance: this entirely fakes the
        // agent turn (no live LLM configured for a CI-safe run) by staging
        // propose_file_merge's tool-call events as a static SSE body, and
        // injects a threadId into the real workspace list response (a fresh
        // workspace's threadId is null until a first real chat message
        // exists) so FilesTab's Agent Resolve wiring has something to call
        // useThreadInstance/sendMessage with.
        const threadId = 'e2e-mock-thread';
        await page.route('**/api/v1/workspaces', async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          const response = await route.fetch();
          const body = (await response.json()) as Array<Record<string, unknown>>;
          const patched = body.map((w) => (w['id'] === ws.id ? { ...w, threadId } : w));
          return route.fulfill({ response, json: patched });
        });

        // The chat GET (hydrate) and POST (sendMessage) are mocked together,
        // consistently: a thread this fake doesn't exist server-side, so the
        // real GET would legitimately report an empty history (workspace-
        // chat.route.ts treats an unknown threadId as "pre-first-message",
        // not a 404) — which WorkspaceChatTab's own mount-time hydrate()
        // would then apply, wiping out whatever the mocked POST's SSE
        // stream had just staged. Mocking the GET to echo the same staged
        // tool call keeps the two consistent, per e2e/AGENTS.md's "mock
        // hydration, not the live turn" guidance.
        const mergedContent = 'merged by the agent\n';
        const toolCallMessage = {
          kind: 'tool_call',
          id: 'm1',
          toolCallId: 'tc1',
          toolName: 'propose_file_merge',
          inputs: { path: 'conflict.txt', mergedContent, explanation: 'combined both sides' },
          outputs: 'Proposed a merged version',
          status: 'done',
        };
        let historyMessages: unknown[] = [];
        await page.route(`**/api/v1/workspaces/${ws.id}/chat/${threadId}`, async (route) => {
          const method = route.request().method();
          if (method === 'GET') {
            return route.fulfill({
              json: { messages: historyMessages, summaryPath: null, summarizedAt: null },
            });
          }
          if (method !== 'POST') return route.fallback();

          historyMessages = [toolCallMessage];
          const events = [
            {
              type: 'tool_call_start',
              messageId: toolCallMessage.id,
              toolCallId: toolCallMessage.toolCallId,
              toolName: toolCallMessage.toolName,
              inputs: toolCallMessage.inputs,
            },
            {
              type: 'tool_call_end',
              toolCallId: toolCallMessage.toolCallId,
              outputs: toolCallMessage.outputs,
            },
            { type: 'stream_done', durationMs: 10 },
          ];
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
          });
        });

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);
        await fileRow(page, 'conflict.txt').click();
        await replaceEditorContent(page, 'conflict.txt', 'my draft\n');

        // Force the conflict without a second tab: edit on disk, then click
        // the already-active tab, which still re-runs the reactivation
        // check (TabButton's onClick always calls activateTab).
        await writeFileDirect(ws.location, 'conflict.txt', 'changed on disk\n');
        await fileTab(page, 'conflict.txt').click();
        const banner = editorPane(page, 'conflict.txt').getByTestId('file-conflict-banner');
        await expect(banner).toBeVisible();

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await banner.getByRole('button', { name: 'Agent Resolve' }).click();

        await expect(page.getByTestId('file-tree')).not.toBeVisible();
        await page.getByRole('button', { name: 'Files' }).click();

        await expect(editorPane(page, 'conflict.txt').locator('.cm-content')).toHaveText(
          mergedContent,
        );
        await expect(
          fileTab(page, 'conflict.txt').locator('[data-testid="tab-unsaved-dot"]'),
        ).toBeVisible();

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      tag: [TAGS.Smoke],
      action: "Open a file, then delete it via its row's delete icon",
      expectedOutcome:
        'The confirm modal names the file; confirming removes it from both the tree and disk, and its open tab closes with no further confirmation prompt',
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-delete-file-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-delete-file-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'doomed.txt', 'about to be deleted\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);
        await fileRow(page, 'doomed.txt').click();
        await expect(fileTab(page, 'doomed.txt')).toBeVisible();

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'doomed.txt').hover();
        await fileRow(page, 'doomed.txt').getByTestId('file-tree-action-delete').click();

        // Scoped to this row's own delete dialog specifically, not just
        // the row (which, for a directory, would also contain its New
        // File/New Folder dialogs) or page-wide getByRole('dialog') (every
        // row's dialogs are present in the DOM regardless of open state —
        // hidden via opacity, not the native [not(open)] UA display:none —
        // so either broader query matches several).
        const dialog = fileRow(page, 'doomed.txt')
          .getByRole('dialog')
          .filter({ hasText: 'Delete file' });
        await expect(dialog).toContainText('Delete file "doomed.txt"?');
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

        await expect(fileRow(page, 'doomed.txt')).toHaveCount(0);
        await expect(fileTab(page, 'doomed.txt')).toHaveCount(0);
        expect(existsSync(`${ws.location}/doomed.txt`)).toBe(false);

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action: "Open a nested file, then delete its parent folder via the folder row's delete icon",
      expectedOutcome:
        "The confirm modal calls out the delete as recursive; confirming removes the folder, its contents, and closes the nested file's open tab too",
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-delete-folder-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-delete-folder-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(ws.location, 'sub/nested.txt', 'inside the doomed folder\n');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);
        await fileRow(page, 'sub').getByTestId('file-tree-chevron').click();
        await fileRow(page, 'sub/nested.txt').click();
        await expect(fileTab(page, 'sub/nested.txt')).toBeVisible();

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await fileRow(page, 'sub').hover();
        await fileRow(page, 'sub').getByTestId('file-tree-action-delete').click();

        const dialog = fileRow(page, 'sub')
          .getByRole('dialog')
          .filter({ hasText: 'Delete folder' });
        await expect(dialog).toContainText('Delete folder "sub"?');
        await expect(dialog).toContainText('everything inside it');
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

        await expect(fileRow(page, 'sub')).toHaveCount(0);
        await expect(fileTab(page, 'sub/nested.txt')).toHaveCount(0);
        expect(existsSync(`${ws.location}/sub`)).toBe(false);

        await page.request.delete(`/api/v1/workspaces/${ws.id}`);
      },
    },
    {
      action:
        'Open a JSON file, collapse a nested object via its fold-gutter marker, then use Collapse All/Expand All',
      expectedOutcome:
        "Clicking the nested object's gutter marker hides only its own lines, leaving a sibling key visible; Collapse All then hides that sibling too; Expand All restores everything",
      test: async ({ page }, testInfo) => {
        const ws = await createWorkspace(
          page.request,
          {
            name: `fb-fold-${Date.now()}`,
            locationRoot: 'temporary',
            directoryName: `fb-fold-${Date.now()}`,
            git: false,
          },
          createdLocations,
        );
        await writeFileDirect(
          ws.location,
          'nested.json',
          '{\n  "outer": {\n    "inner": "value"\n  },\n  "sibling": "stays visible"\n}\n',
        );

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await openFilesTab(page, ws.id);
        await fileRow(page, 'nested.json').click();
        const pane = editorPane(page, 'nested.json');
        await expect(pane.locator('.cm-content')).toContainText('sibling');

        // One gutter marker per rendered line; index 1 is the "outer"
        // object's opening line, the fold target one level in from the
        // root object.
        await pane.locator('.cm-foldGutter .cm-gutterElement').nth(1).click();
        await expect(pane.locator('.cm-foldPlaceholder')).toBeVisible();
        await expect(pane.locator('.cm-content')).not.toContainText('inner');
        await expect(pane.locator('.cm-content')).toContainText('sibling');

        await pauseForVideo(page, WorkspaceFileBrowser, testInfo);
        await pane.getByRole('button', { name: 'Collapse All' }).click();
        await expect(pane.locator('.cm-content')).not.toContainText('sibling');

        await pane.getByRole('button', { name: 'Expand All' }).click();
        await expect(pane.locator('.cm-foldPlaceholder')).toHaveCount(0);
        await expect(pane.locator('.cm-content')).toContainText('inner');
        await expect(pane.locator('.cm-content')).toContainText('sibling');

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
suiteRunner(CreateTask);
suiteRunner(CreateScheduledTasks);
suiteRunner(CronAbortWatch);
suiteRunner(CohortGating);
