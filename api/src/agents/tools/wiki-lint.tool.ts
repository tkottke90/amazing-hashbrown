import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { LintReport } from '@tkottke90/llm-wiki';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiLintSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID to lint, as returned by wiki_locate or wiki_search.'),
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
      "Run the wiki's health checks against one domain and get a grouped severity report. " +
      'Every finding type now has a fix path: ' +
      '"broken_links"/"index"/"stale"/"frontmatter"/"page_size"/"log_rotation" → wiki_read_page + wiki_update_page; ' +
      '"tag_audit" → wiki_update_page with tags param; ' +
      '"quality"/"contradictions" → wiki_update_page with confidence/contested/contradictions params; ' +
      '"orphans" → wiki_add_cross_link (read the orphaned page first to identify a link target); ' +
      '"source_drift" → wiki_rebaseline_source; ' +
      '"registry_sync" → wiki_register_domain.',
    schema: WikiLintSchema,
  },
);
