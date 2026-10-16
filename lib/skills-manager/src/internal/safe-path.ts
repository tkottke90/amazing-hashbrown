// File-artifact safety shared by the REST route layer (skills.handlers.ts)
// and anything else that calls SkillsManager.readFile/writeFile/deleteFile
// directly. SkillsManager itself does no basename/dir validation — it joins
// its arguments straight into a filesystem path — so every caller going
// around the route needs this same check rather than a weaker copy of it.

export const FILE_DIRS = ['scripts', 'references'] as const;
export type FileDir = (typeof FILE_DIRS)[number];

// 'evals' is a valid SkillsManager.writeFile/readFile dir, but deliberately
// excluded here: evals content goes through loadEvals/saveEvals (a single
// evals.json, not arbitrary named files), not this generic file-artifact
// path.
export function isValidDir(dir: string): dir is FileDir {
  return (FILE_DIRS as readonly string[]).includes(dir);
}

export const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeBasename(basename: string): boolean {
  return BASENAME_RE.test(basename) && !basename.includes('..');
}
