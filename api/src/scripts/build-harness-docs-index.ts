// Build-time corpus generator for the search_harness_docs tool
// (api/src/agents/tools/search-harness-docs.tool.ts). Converts GLOSSARY.md
// and docs/App-Docs/*.md into pages inside a standalone LlmWiki instance —
// never registered with the real WikiRegistry, so wiki_search/wiki_locate/
// AfterAgent never see or write to it (docs/superpowers/specs/
// 2026-11-13-harness-docs-tool-corpus-design.md).
//
// Run by both `npm run build` (compiled, via node) and `npm run dev` (via
// tsx, before the watcher starts) — see api/package.json. Content chunking
// only; no embeddingProvider here, since a build server doesn't know which
// embedding provider a given install is configured with — vectors are
// computed at runtime by the tool itself.
//
// The output directory is wiped and rebuilt fresh on every run rather than
// updated incrementally, so a renamed/removed GLOSSARY term or doc heading
// never leaves a stale page behind.

import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmWiki } from '@tkottke90/llm-wiki';
import type { PageInput } from '@tkottke90/llm-wiki';
import { parseAppDoc, parseGlossary } from './harness-docs-parser.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../');
const OUTPUT_DIR = path.resolve(import.meta.dirname, '../../generated/harness-docs-wiki');
const GLOSSARY_PATH = path.join(REPO_ROOT, 'GLOSSARY.md');
const APP_DOCS_DIR = path.join(REPO_ROOT, 'docs/App-Docs');

async function collectPages(): Promise<PageInput[]> {
  const pages: PageInput[] = [];

  const glossary = await readFile(GLOSSARY_PATH, 'utf8');
  pages.push(...parseGlossary(glossary));

  const appDocFiles = (await readdir(APP_DOCS_DIR)).filter((f) => f.endsWith('.md'));
  for (const file of appDocFiles) {
    const content = await readFile(path.join(APP_DOCS_DIR, file), 'utf8');
    pages.push(...parseAppDoc(file, content));
  }

  return pages;
}

export async function buildHarnessDocsIndex(): Promise<void> {
  await rm(OUTPUT_DIR, { recursive: true, force: true });

  const wiki = await LlmWiki.create({
    path: OUTPUT_DIR,
    name: 'Harness Docs',
    domain: 'harness self-documentation',
  });

  const pages = await collectPages();
  for (const page of pages) {
    await wiki.commitPage(page);
  }

  const report = await wiki.lint();
  const errors = report.checks.filter((c) => c.severity === 'error');
  if (!report.ok) {
    console.error(`harness-docs-index: ${errors.length} lint error(s):`);
    for (const finding of errors) {
      console.error(`  [${finding.check}] ${finding.page ?? ''} ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`harness-docs-index: committed ${pages.length} pages to ${OUTPUT_DIR}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  buildHarnessDocsIndex().catch((err) => {
    console.error('harness-docs-index: build failed:', err);
    process.exitCode = 1;
  });
}
