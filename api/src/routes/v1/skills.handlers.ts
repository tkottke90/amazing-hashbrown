import { z } from 'zod';
import type {
  SkillsManager,
  Skill,
  SkillSummary,
  CreateSkillInput,
  EditSkillInput,
  EvalSuite,
} from '@tkottke90/skills-manager';

// Plain, Express-agnostic handler functions — no req/res anywhere, same idiom
// as settings.handlers.ts/projects.handlers.ts. This file declares its own
// local HandlerFailure/HandlerResult (rather than importing the narrower
// type from threads.handlers.ts) because it needs both a 409 status (gated
// skill delete) and fieldErrors (zod validation) at once — settings.handlers.ts
// does the same thing for the same reason.

export interface HandlerFailure {
  ok: false;
  status: 400 | 404 | 409 | 500;
  error: string;
  fieldErrors?: Record<string, string[]>;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function invalid(error: string, fieldErrors?: Record<string, string[]>): HandlerFailure {
  return { ok: false, status: 400, error, fieldErrors };
}

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

function skillExists(manager: SkillsManager, name: string): boolean {
  return manager.list().some((s) => s.name === name);
}

function mapCreateSkillError(err: unknown): HandlerFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('already exists')) return conflict(message);
  if (message.includes('Invalid skill name')) return invalid(message);
  return serverError(message);
}

// ---- Request body schemas ----------------------------------------------------
// Only `name`/`description` are checked for non-emptiness here — the
// manager's own NAME_RE/length check remains the single source of truth for
// name *format*, mapped to 400 via mapCreateSkillError above rather than
// duplicated in a zod regex.

const MetadataSchema = z.record(z.string(), z.string());

const CreateSkillSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().min(1, 'description is required'),
  body: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
});

const EditSkillSchema = z.object({
  description: z.string().min(1).optional(),
  body: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
  enabled: z.boolean().optional(),
});

const EvalCaseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  prompt: z.string(),
  expected_output: z.string(),
  files: z.array(z.string()).optional(),
  assertions: z.array(z.string()).optional(),
});

const EvalSuiteSchema = z.object({
  skill_name: z.string(),
  evals: z.array(EvalCaseSchema),
});

// ---- File path safety ---------------------------------------------------------
// SkillsManager.readFile/writeFile/deleteFile join `basename` straight into a
// filesystem path with no validation of their own — this is where
// path-traversal protection has to live for these new routes.

const FILE_DIRS = ['scripts', 'references'] as const;
type FileDir = (typeof FILE_DIRS)[number];

function isValidDir(dir: string): dir is FileDir {
  return (FILE_DIRS as readonly string[]).includes(dir);
}

const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeBasename(basename: string): boolean {
  return BASENAME_RE.test(basename) && !basename.includes('..');
}

// ---- Handlers -------------------------------------------------------------

export function searchSkillsHandler(
  manager: SkillsManager,
  q?: string,
  all?: boolean,
): HandlerResult<{ skills: SkillSummary[] }> {
  return ok({ skills: all ? manager.list() : manager.search(q) });
}

export async function getSkillHandler(
  manager: SkillsManager,
  name: string,
): Promise<HandlerResult<Skill>> {
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  try {
    return ok(await manager.load(name));
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function createSkillHandler(
  manager: SkillsManager,
  body: unknown,
): Promise<HandlerResult<Skill>> {
  const parsed = CreateSkillSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(
      'Validation failed',
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  try {
    return ok(await manager.create(parsed.data as CreateSkillInput));
  } catch (err) {
    return mapCreateSkillError(err);
  }
}

export async function editSkillHandler(
  manager: SkillsManager,
  name: string,
  body: unknown,
): Promise<HandlerResult<Skill>> {
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  const parsed = EditSkillSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(
      'Validation failed',
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  try {
    return ok(await manager.edit(name, parsed.data as EditSkillInput));
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteSkillHandler(
  manager: SkillsManager,
  name: string,
  gatedNames: readonly string[],
): Promise<HandlerResult<{ deleted: true }>> {
  // Checked before existence or any manager call — this is a business rule
  // independent of whether the skill happens to exist right now.
  if (gatedNames.includes(name)) {
    return conflict(`Skill "${name}" is required by tool-gating and cannot be deleted`);
  }
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  try {
    await manager.delete(name);
    return ok({ deleted: true });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function readSkillFileHandler(
  manager: SkillsManager,
  name: string,
  dir: string,
  basename: string,
): Promise<HandlerResult<{ content: string }>> {
  if (!isValidDir(dir)) return invalid(`dir must be one of: ${FILE_DIRS.join(', ')}`);
  if (!isSafeBasename(basename)) return invalid('Invalid file name');
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  try {
    const content = await manager.readFile(name, dir, basename);
    return ok({ content });
  } catch (err) {
    if (isEnoent(err)) return notFound(`File "${basename}" not found`);
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function writeSkillFileHandler(
  manager: SkillsManager,
  name: string,
  dir: string,
  basename: string,
  body: unknown,
): Promise<HandlerResult<{ saved: true }>> {
  if (!isValidDir(dir)) return invalid(`dir must be one of: ${FILE_DIRS.join(', ')}`);
  if (!isSafeBasename(basename)) return invalid('Invalid file name');
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  const content = (body as { content?: unknown } | null)?.content;
  if (typeof content !== 'string') return invalid('content is required');
  try {
    await manager.writeFile(name, dir, basename, content);
    return ok({ saved: true });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteSkillFileHandler(
  manager: SkillsManager,
  name: string,
  dir: string,
  basename: string,
): Promise<HandlerResult<{ deleted: true }>> {
  if (!isValidDir(dir)) return invalid(`dir must be one of: ${FILE_DIRS.join(', ')}`);
  if (!isSafeBasename(basename)) return invalid('Invalid file name');
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  try {
    await manager.deleteFile(name, dir, basename);
    return ok({ deleted: true });
  } catch (err) {
    if (isEnoent(err)) return notFound(`File "${basename}" not found`);
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function getSkillEvalsHandler(
  manager: SkillsManager,
  name: string,
): Promise<HandlerResult<EvalSuite>> {
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  try {
    return ok(await manager.loadEvals(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No evals/evals.json yet is not an error from this endpoint's
    // perspective — always hand back a valid, possibly-empty suite.
    if (message.includes('No evals found for skill')) {
      return ok({ skill_name: name, evals: [] });
    }
    return serverError(message);
  }
}

export async function saveSkillEvalsHandler(
  manager: SkillsManager,
  name: string,
  body: unknown,
): Promise<HandlerResult<{ saved: true }>> {
  if (!skillExists(manager, name)) return notFound(`Skill "${name}" not found`);
  const parsed = EvalSuiteSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(
      'Validation failed',
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  try {
    await manager.saveEvals(name, parsed.data as EvalSuite);
    return ok({ saved: true });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}
