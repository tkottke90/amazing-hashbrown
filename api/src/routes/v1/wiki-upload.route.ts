import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';
import type { Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';
import {
  createUploadJob,
  setUploadState,
  getUploadState,
} from '../../services/wiki-upload-store.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const execFileAsync = promisify(execFile);

export const wikiUploadRouter = Router();

// ---------------------------------------------------------------------------
// Unzip capability check (done once at module load; .zip disabled on Alpine)
// ---------------------------------------------------------------------------

let zipSupported = false;
execFile('which', ['unzip'], (err) => {
  zipSupported = !err;
  logger.info('Wiki upload: zip support', { available: zipSupported });
});

// ---------------------------------------------------------------------------
// DMZ directory
// ---------------------------------------------------------------------------

const dmzRoot = path.resolve(process.cwd(), env.wikiRoot ?? './wiki', '_dmz');

// ---------------------------------------------------------------------------
// Multer — disk storage into the DMZ; jobId injected before middleware fires
// ---------------------------------------------------------------------------

interface RequestWithJobId extends Request {
  jobId: string;
}

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const jobId = (req as RequestWithJobId).jobId;
    const dir = path.join(dmzRoot, jobId);
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err as Error, '');
    }
  },
  filename: (_req, file, cb) => cb(null, file.originalname),
});

function buildFileFilter(acceptZip: boolean) {
  return (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ok = acceptZip
      ? /\.(tar\.gz|tgz|tar|zip)$/i.test(file.originalname)
      : /\.(tar\.gz|tgz|tar)$/i.test(file.originalname);
    cb(null, ok);
  };
}

function buildUpload() {
  return multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: buildFileFilter(zipSupported),
  });
}

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const WIKI_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const UploadBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(WIKI_ID_RE, 'must be lowercase letters, digits, and hyphens'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const name = path.basename(archivePath).toLowerCase();
  await fs.mkdir(destDir, { recursive: true });

  if (name.endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archivePath, '-d', destDir]);
  } else {
    // .tar, .tar.gz, .tgz — tar handles all three via -xf
    await execFileAsync('tar', ['-xf', archivePath, '-C', destDir]);
  }
}

/** Validate that the extracted directory has the expected wiki structure. */
async function validateStructure(extractedDir: string): Promise<string | null> {
  const required = ['SCHEMA.md', 'index.md', 'log.md'];
  for (const f of required) {
    try {
      await fs.access(path.join(extractedDir, f));
    } catch {
      return `Missing required file: ${f}`;
    }
  }

  // At least one content directory must exist
  const contentDirs = ['entities', 'concepts', 'comparisons', 'queries', 'raw'];
  let hasContent = false;
  for (const d of contentDirs) {
    try {
      const stat = await fs.stat(path.join(extractedDir, d));
      if (stat.isDirectory()) {
        hasContent = true;
        break;
      }
    } catch {
      // directory absent — keep checking
    }
  }
  if (!hasContent)
    return `Archive must contain at least one content directory (${contentDirs.join(', ')})`;

  // Path-traversal guard: ensure all files resolve within extractedDir
  const allEntries = await walkDir(extractedDir);
  for (const entry of allEntries) {
    if (!path.resolve(entry).startsWith(path.resolve(extractedDir))) {
      return `Archive contains path traversal entry: ${entry}`;
    }
  }

  return null; // valid
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}

async function cleanupDmzJob(jobId: string): Promise<void> {
  try {
    await fs.rm(path.join(dmzRoot, jobId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function rollback(wikiId: string, wikiPath: string, jobId: string): Promise<void> {
  await fs.rm(wikiPath, { recursive: true, force: true }).catch(() => undefined);
  try {
    const registry = await getWikiRegistry();
    await registry.remove(wikiId);
  } catch {
    // already removed or never registered
  }
  await cleanupDmzJob(jobId);
}

// ---------------------------------------------------------------------------
// Async upload pipeline — runs after the HTTP response is sent
// ---------------------------------------------------------------------------

async function processUpload(jobId: string, wikiId: string, archivePath: string): Promise<void> {
  const dmzJobDir = path.join(dmzRoot, jobId);
  const extractedDir = path.join(dmzJobDir, 'extracted');
  const wikiRoot = path.resolve(process.cwd(), env.wikiRoot ?? './wiki');
  const wikiDestPath = path.join(wikiRoot, wikiId);

  try {
    // ── Stage: unpacking ────────────────────────────────────────────────────
    setUploadState(jobId, { stage: 'unpacking' });
    try {
      await extractArchive(archivePath, extractedDir);
    } catch (err) {
      setUploadState(jobId, { stage: 'failed', error: `Extraction failed: ${String(err)}` });
      await cleanupDmzJob(jobId);
      return;
    }

    // ── Stage: validating ───────────────────────────────────────────────────
    setUploadState(jobId, { stage: 'validating' });
    const validationError = await validateStructure(extractedDir);
    if (validationError) {
      setUploadState(jobId, { stage: 'failed', error: `Validation failed: ${validationError}` });
      await cleanupDmzJob(jobId);
      return;
    }

    // ── Stage: registering ──────────────────────────────────────────────────
    setUploadState(jobId, { stage: 'registering' });
    try {
      await fs.rename(extractedDir, wikiDestPath);
    } catch (err) {
      setUploadState(jobId, {
        stage: 'failed',
        error: `Could not move wiki to destination: ${String(err)}`,
      });
      await cleanupDmzJob(jobId);
      return;
    }

    let registry;
    try {
      registry = await getWikiRegistry();
      await registry.register(wikiId);
    } catch (err) {
      setUploadState(jobId, {
        stage: 'failed',
        error: `Registration failed: ${String(err)}`,
      });
      await rollback(wikiId, wikiDestPath, jobId);
      return;
    }

    // ── Stage: linting ──────────────────────────────────────────────────────
    setUploadState(jobId, { stage: 'linting' });
    let lintReport;
    try {
      lintReport = await registry.lint(wikiId);
    } catch (err) {
      setUploadState(jobId, {
        stage: 'failed',
        error: `Lint check failed to run: ${String(err)}`,
      });
      await rollback(wikiId, wikiDestPath, jobId);
      return;
    }

    const lintErrors = lintReport.checks.filter((c) => c.severity === 'error');
    if (lintErrors.length > 0) {
      const summary = lintErrors.map((c) => `${c.check}: ${c.message}`).join('; ');
      setUploadState(jobId, {
        stage: 'failed',
        error: `Wiki has ${lintErrors.length} error-severity lint finding(s) — fix before uploading. ${summary}`,
      });
      await rollback(wikiId, wikiDestPath, jobId);
      return;
    }

    // ── Stage: embedding ────────────────────────────────────────────────────
    if (env.embeddings?.enabled) {
      setUploadState(jobId, { stage: 'embedding', pagesEmbedded: 0, pagesTotal: 0 });
      try {
        const wiki = await registry.load(wikiId);
        await wiki.reIndex((done, total) => {
          setUploadState(jobId, { stage: 'embedding', pagesEmbedded: done, pagesTotal: total });
        });
      } catch (err) {
        // Embedding failure is non-fatal — wiki is already registered and valid
        logger.warn('Wiki upload: embedding failed (non-fatal)', { wikiId, err: String(err) });
      }
    }

    // ── Done ────────────────────────────────────────────────────────────────
    setUploadState(jobId, { stage: 'done', wikiId, lintReport });
    await cleanupDmzJob(jobId);
    logger.info('Wiki upload complete', { jobId, wikiId });
  } catch (err) {
    logger.error('Wiki upload unexpected error', { jobId, err: String(err) });
    setUploadState(jobId, { stage: 'failed', error: `Unexpected error: ${String(err)}` });
    await rollback(wikiId, wikiDestPath, jobId).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /capabilities — tells the UI which archive formats are accepted
wikiUploadRouter.get('/capabilities', (_req, res) => {
  const formats = ['.tar.gz', '.tgz', '.tar'];
  if (zipSupported) formats.push('.zip');
  res.json({ acceptedFormats: formats });
});

// POST / — start an upload; responds 202 immediately, processes in background
wikiUploadRouter.post(
  '/',
  // Inject jobId before multer runs so its destination function can use it
  (req, _res, next) => {
    (req as RequestWithJobId).jobId = crypto.randomUUID();
    next();
  },
  (req, res, next) => {
    buildUpload().single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof multer.MulterError ? err.message : 'Upload failed';
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const jobId = (req as RequestWithJobId).jobId;

    if (!req.file) {
      res.status(400).json({ error: 'file is required (multipart field name "file")' });
      return;
    }

    // Server-side name validation (never trust frontend)
    const parsed = UploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await fs
        .rm(path.join(dmzRoot, jobId), { recursive: true, force: true })
        .catch(() => undefined);
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid name' });
      return;
    }
    const wikiId = parsed.data.name;

    // Check for name collision
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      res.status(503).json({ error: 'Wiki registry unavailable' });
      return;
    }
    if (registry.list().some((w) => w.id === wikiId)) {
      await fs
        .rm(path.join(dmzRoot, jobId), { recursive: true, force: true })
        .catch(() => undefined);
      res.status(409).json({ error: `Wiki domain "${wikiId}" already exists` });
      return;
    }

    createUploadJob(jobId);
    res.status(202).json({ jobId });

    // Fire-and-forget — response already sent
    void processUpload(jobId, wikiId, req.file.path);
  },
);

// GET /:jobId — poll for status
wikiUploadRouter.get('/:jobId', (req, res) => {
  const { jobId } = req.params as { jobId: string };
  const state = getUploadState(jobId);
  if (!state) {
    res.status(404).json({ error: 'Upload job not found or expired' });
    return;
  }
  res.json(state);
});
