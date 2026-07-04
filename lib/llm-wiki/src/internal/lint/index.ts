/** Lint runner: composes the individual checks into a structured report. */

import type { LintCheckId, LintFinding, LintReport } from '../../types.js';
import type { LintContext } from './checks.js';
import * as checks from './checks.js';

export type { LintContext, LintPage, LintRawFile } from './checks.js';

const CHECK_FNS: Record<LintCheckId, (ctx: LintContext) => LintFinding[]> = {
  orphans: checks.checkOrphans,
  broken_links: checks.checkBrokenLinks,
  index: checks.checkIndex,
  frontmatter: checks.checkFrontmatter,
  page_size: checks.checkPageSize,
  tag_audit: checks.checkTagAudit,
  source_drift: checks.checkSourceDrift,
  log_rotation: checks.checkLogRotation,
  stale: checks.checkStale,
  quality: checks.checkQuality,
  contradictions: checks.checkContradictions,
  registry_sync: checks.checkRegistrySync,
};

export const ALL_CHECKS = Object.keys(CHECK_FNS) as LintCheckId[];

export interface RunLintOptions {
  /** Restrict to a subset of checks. Defaults to all. */
  only?: LintCheckId[];
}

export function runLint(ctx: LintContext, opts: RunLintOptions = {}): LintReport {
  const ids = opts.only ?? ALL_CHECKS;
  const findings = ids.flatMap((id) => CHECK_FNS[id](ctx));
  return {
    ok: !findings.some((f) => f.severity === 'error'),
    checks: findings,
  };
}
