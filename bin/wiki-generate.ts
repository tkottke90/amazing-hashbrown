#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LlmWiki } from '../lib/llm-wiki/src/index.js';
import type { PageType } from '../lib/llm-wiki/src/index.js';
import { OllamaInferenceAdapter } from '../lib/inference-adapter/src/adapters/ollama.js';
import { OpenAiInferenceAdapter } from '../lib/inference-adapter/src/adapters/openai.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force: { type: 'boolean', default: false },
    provider: { type: 'string', default: 'ollama' },
    model: { type: 'string', default: 'llama3.1' },
    'base-url': { type: 'string', default: 'http://localhost:11434' },
    'api-key': { type: 'string' },
  },
  strict: false,
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(projectRoot, 'docs/app-wiki');
const outputDir = resolve(projectRoot, 'lib/assets/app-wiki');

// ── Load source docs ──────────────────────────────────────────────────────────

let sourceFiles: string[];
try {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  sourceFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== '.gitkeep')
    .map((e) => e.name);
} catch {
  console.error(`Error: cannot read source directory at ${sourceDir}`);
  process.exit(2);
}

if (sourceFiles.length === 0) {
  console.log('No source files found in docs/app-wiki/ — nothing to generate.');
  process.exit(0);
}

// ── Set up inference ──────────────────────────────────────────────────────────

let adapter: OllamaInferenceAdapter | OpenAiInferenceAdapter;
if (values.provider === 'ollama') {
  adapter = new OllamaInferenceAdapter({
    model: values.model as string,
    baseUrl: values['base-url'] as string,
  });
} else if (values.provider === 'openai') {
  adapter = new OpenAiInferenceAdapter({
    model: values.model as string,
    baseUrl: values['base-url'] as string,
    apiKey: values['api-key'] as string | undefined,
  });
} else {
  console.error(
    `Error: provider "${values.provider}" is not supported. Use --provider ollama or --provider openai.`,
  );
  process.exit(2);
}

// ── Load or create the output wiki ───────────────────────────────────────────

let wiki: LlmWiki;
try {
  wiki = await LlmWiki.load(outputDir);
} catch {
  console.error(
    `Error: could not load wiki at ${outputDir}. Ensure lib/assets/app-wiki/SCHEMA.md exists.`,
  );
  process.exit(2);
}

// ── Page generation schema ────────────────────────────────────────────────────

const PageSchema = z.object({
  pages: z.array(
    z.object({
      type: z.enum(['concept', 'entity', 'query']),
      title: z.string(),
      tags: z.array(z.string()),
      body: z.string(),
      summary: z.string().optional(),
    }),
  ),
});

// ── Process each source file ──────────────────────────────────────────────────

let generated = 0;
let skipped = 0;

for (const filename of sourceFiles) {
  const sourcePath = resolve(sourceDir, filename);
  const content = await readFile(sourcePath, 'utf8');

  const prep = await wiki.ingestPrep({ content, filename });

  if (!prep.isNew && !prep.drift && !values.force) {
    console.log(`  skip  ${filename} (unchanged)`);
    skipped++;
    continue;
  }

  console.log(`  gen   ${filename}`);

  const { path: rawPath } = await wiki.saveRawSource({
    content,
    sourceUrl: filename,
    sha256: prep.sha256,
  });

  const response = await adapter.invoke(
    [
      {
        role: 'user',
        content: [
          'You are converting developer documentation into a user-facing wiki.',
          'Read the following documentation and produce structured wiki pages.',
          'Each page should explain a concept, feature, or how-to in plain language.',
          'Do not include API internals or developer architecture.',
          'Use [[wikilink]] syntax to cross-reference related pages.',
          '',
          '--- SOURCE DOCUMENT ---',
          content,
          '--- END ---',
          '',
          'Return a JSON object with a "pages" array. Each page needs:',
          '- type: "concept" | "entity" | "query"',
          '- title: string',
          '- tags: string[] (from: configuration, provider, wiki, mcp, skills, evaluations, shell, ui, setup, how-to, reference)',
          '- body: markdown string (no frontmatter)',
          '- summary: optional one-line summary',
        ].join('\n'),
      },
    ],
    { schema: PageSchema },
  );

  let parsed: z.infer<typeof PageSchema>;
  try {
    parsed = PageSchema.parse(response.structured);
  } catch {
    console.warn(`  warn  ${filename}: LLM returned invalid structure, skipping`);
    continue;
  }

  for (const page of parsed.pages) {
    await wiki.commitPage({
      type: page.type as PageType,
      title: page.title,
      tags: page.tags,
      sources: [rawPath],
      body: page.body,
      summary: page.summary,
    });
    console.log(`        wrote ${page.type}: ${page.title}`);
  }

  generated += parsed.pages.length;
}

console.log(`\nDone: ${generated} pages written, ${skipped} source files skipped (unchanged).`);

// ── Lint ──────────────────────────────────────────────────────────────────────

const report = await wiki.lint();
const errors = report.checks.filter((c) => c.severity === 'error');
const warnings = report.checks.filter((c) => c.severity === 'warn');

if (warnings.length > 0) {
  console.log(`\nLint warnings (${warnings.length}):`);
  for (const w of warnings) {
    console.log(`  warn  [${w.check}] ${w.message}`);
  }
}

if (errors.length > 0) {
  console.error(`\nLint errors (${errors.length}):`);
  for (const e of errors) {
    console.error(`  error [${e.check}] ${e.message}`);
  }
  process.exit(1);
}

process.exit(0);
