import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';

// Small helper module for the 003-WorkspaceFileBrowser suite — warranted
// (unlike workspace-project.spec.ts's inline-only style) because that suite
// needs repeated real git/filesystem setup across its 12 steps: writing
// files directly to a workspace's real on-disk `location` (bypassing the
// app's own API, to set up state the app itself will then read/observe) and
// tearing those directories down again once the suite is done.

// Writes `content` to `relativePath` under `location`, creating any missing
// intermediate directories first (a fresh nested path like "src/module.txt"
// has no parent directory yet).
export async function writeFileDirect(
  location: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absPath = path.join(location, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, content, 'utf8');
}

// `git init` plus a local user.email/user.name — required so `commitAll`
// below can actually create a commit in a fresh CI checkout that has no
// global git config (`git commit` fails without an identity).
export function initGitRepo(location: string): void {
  execFileSync('git', ['init'], { cwd: location });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: location });
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: location });
}

export function commitAll(location: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: location });
  execFileSync('git', ['commit', '-m', message], { cwd: location });
}

// Writes a file whose content includes a null byte, tripping the server's
// binary sniff (workspace-files.ts's readFileGuarded) regardless of file
// extension.
export async function writeBinaryFile(location: string, relativePath: string): Promise<void> {
  const absPath = path.join(location, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  await writeFile(absPath, buffer);
}

// A real, decodable 1x1 transparent PNG — unlike writeBinaryFile above, this
// must actually decode: a failed <img> decode can collapse the element's
// intrinsic box in some browsers and break a Playwright visibility check.
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function writeImageFile(location: string, relativePath: string): Promise<void> {
  const absPath = path.join(location, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, Buffer.from(MINIMAL_PNG_BASE64, 'base64'));
}

// Native <audio controls>/<video controls> chrome mounts regardless of
// decode success (only playback would fail), so these don't need to be
// byte-perfect the way writeImageFile's PNG does — a few arbitrary bytes
// under the right extension is enough to exercise the route/element wiring.
export async function writeAudioFile(location: string, relativePath: string): Promise<void> {
  const absPath = path.join(location, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
}

export async function writeVideoFile(location: string, relativePath: string): Promise<void> {
  const absPath = path.join(location, relativePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
}

// Classification is extension-only (workspace-files.ts's classifyFile) — the
// content is irrelevant here, this exists purely for call-site clarity
// alongside its image/audio/video siblings above.
export async function writeUnsupportedExtensionFile(
  location: string,
  relativePath: string,
): Promise<void> {
  await writeFileDirect(location, relativePath, 'not a real archive — extension-only classification\n');
}

// Makes a file read-only so a subsequent Save through the app surfaces a
// real disk-level write failure. chmod alone enforces this for a normal
// user, but this suite (like the rest of this repo's dev/CI containers) runs
// as root, and root bypasses the write-permission bit entirely — chmod
// 0o444 alone would NOT actually block root's own write. The immutable
// attribute (chattr +i) is enforced independently of file permissions/uid
// (only CAP_LINUX_IMMUTABLE, which a normal `npm run dev:api` process
// doesn't have, can override it), so it produces a genuine EPERM on write
// even as root — chmod is kept alongside it for filesystems where chattr
// isn't supported (e.g. a CI runner on a non-ext filesystem) and to keep the
// on-disk permission bits semantically correct either way.
export async function makeReadOnly(location: string, relativePath: string): Promise<void> {
  const absPath = path.join(location, relativePath);
  await chmod(absPath, 0o444);
  try {
    execFileSync('chattr', ['+i', absPath], { stdio: 'ignore' });
  } catch {
    // chattr isn't available/supported on every filesystem (e.g. tmpfs,
    // non-Linux CI runners) — the chmod above is still real protection for
    // any non-root process, so this is a best-effort strengthening, not the
    // only guard.
  }
}

// Reverses makeReadOnly's chattr so a later rm -rf (removeWorkspaceDir, or a
// developer cleaning up manually) doesn't fail on an immutable file.
async function clearImmutable(location: string): Promise<void> {
  try {
    execFileSync('chattr', ['-R', '-i', location], { stdio: 'ignore' });
  } catch {
    // Same best-effort reasoning as makeReadOnly above.
  }
}

// DELETE /api/v1/workspaces/:id only removes the DB rows — it never touches
// the on-disk directory — so every workspace this suite creates must have
// its `location` cleaned up here explicitly (see the suite's test.afterAll).
export async function removeWorkspaceDir(location: string): Promise<void> {
  await clearImmutable(location);
  await rm(location, { recursive: true, force: true });
}
