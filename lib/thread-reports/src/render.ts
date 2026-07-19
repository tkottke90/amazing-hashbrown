import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { marked } from 'marked';
import type { ThreadReportData } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

// Relative-scale duration formatting, same convention as the eval report
// (lib/evaluations/src/serializer.ts) — duplicated rather than imported to
// keep this package's only lib dependency observability-related.
function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function formatJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

let njkEnv: nunjucks.Environment | null = null;
function getNjkEnv(): nunjucks.Environment {
  if (!njkEnv) {
    njkEnv = nunjucks.configure(TEMPLATES_DIR, { autoescape: true });
    njkEnv.addFilter('duration', formatDuration);
    njkEnv.addFilter('reportTime', formatTime);
    njkEnv.addFilter('json', formatJson);
    njkEnv.addFilter('markdown', (text: string) => {
      const html = marked.parse(text ?? '', { async: false }) as string;
      return new nunjucks.runtime.SafeString(html);
    });
  }
  return njkEnv;
}

export async function renderThreadReportHtml(data: ThreadReportData): Promise<string> {
  const styles = await readFile(join(TEMPLATES_DIR, 'base.css'), 'utf-8');
  const env = getNjkEnv();
  return env.render('report.njk', { ...data, styles });
}
