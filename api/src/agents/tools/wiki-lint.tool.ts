import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { LintReport } from '@tkottke90/llm-wiki';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiLintSchema = z.object({
  wikiId: z
    .string()
    .describe('Wiki domain ID to lint, as returned by wiki_locate or wiki_search.'),
});

function formatLintReport(wikiId: string, report: LintReport): string {
  if (report.checks.length === 0) return `Wiki "${wikiId}" is healthy — no issues found.`;

  const bySev = (s: 'error' | 'warn' | 'info') => report.checks.filter((c) => c.severity === s);
  const errors = bySev('error');
  const warnings = bySev('warn');
  const infos = bySev('info');

  const statusLine = report.ok
    ? `Status: ok (${warnings.length} warning(s), ${infos.length} info)`
    : `Status: FAILED (${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info)`;

  const formatGroup = (label: string, findings: LintReport['checks']) =>
    findings.length
      ? [
          `## ${label}`,
          ...findings.map((f) => `- [${f.check}]${f.page ? ` ${f.page}` : ''}: ${f.message}`),
        ]
      : [];

  return [
    `# Wiki Lint: ${wikiId}`,
    '',
    statusLine,
    '',
    ...formatGroup('Errors', errors),
    ...formatGroup('Warnings', warnings),
    ...formatGroup('Info', infos),
  ]
    .join('\n')
    .trimEnd();
}

export const wikiLintTool = tool(
  async ({ wikiId }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }
    let report;
    try {
      report = await registry.lint(wikiId);
    } catch {
      return `Wiki "${wikiId}" is not registered. Use wiki_locate to find available domains.`;
    }
    return formatLintReport(wikiId, report);
  },
  {
    name: 'wiki_lint',
    description:
      "Run the wiki's health checks (broken links, orphaned pages, missing frontmatter, stale " +
      'content, tag/index drift, and more) against one domain. Read-only — reports issues without ' +
      'fixing them. For "broken_links", "index", and "stale" findings, use wiki_read_page and ' +
      'wiki_update_page to fix them; other finding types (tags, confidence, contradictions, orphans) ' +
      "don't have a fix path with the current toolset — say so rather than attempting a workaround.",
    schema: WikiLintSchema,
  },
);
