import robotsParser from 'robots-parser';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { env } from '../config/env.js';

export type WebFetchResult =
  | {
      status: 'ok';
      url: string;
      contentType: 'html' | 'json';
      text: string;
      metadata: { title?: string; description?: string };
      links: Array<{ text: string; href: string }>;
      outline: Array<{ level: number; text: string }>;
    }
  | { status: 'error'; url: string; error: string; httpStatus?: number }
  | { status: 'robots_blocked'; url: string; error: string };

const USER_AGENT = 'amazing-hashbrown/1.0';

// Per-origin robots.txt cache — lives for the process lifetime so the same
// host is not re-fetched on every tool call within a session.
const robotsCache = new Map<string, ReturnType<typeof robotsParser>>();

async function getRobots(url: string): Promise<ReturnType<typeof robotsParser> | null> {
  const { origin } = new URL(url);
  if (robotsCache.has(origin)) {
    return robotsCache.get(origin)!;
  }
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) {
      // 4xx/5xx → treat as "no rules" and allow
      return null;
    }
    const text = await res.text();
    const robots = robotsParser(robotsUrl, text);
    robotsCache.set(origin, robots);
    return robots;
  } catch {
    // Network error fetching robots.txt → allow access
    return null;
  }
}

export async function fetchUrl(url: string): Promise<WebFetchResult> {
  const cfg = env.webFetch;

  if (cfg.respectRobotsTxt) {
    try {
      const robots = await getRobots(url);
      if (robots && !robots.isAllowed(url, USER_AGENT)) {
        return { status: 'robots_blocked', url, error: 'Blocked by robots.txt' };
      }
    } catch {
      // URL parse failure → fall through to the fetch itself, which will also fail
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(cfg.timeoutMs),
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (err) {
    return { status: 'error', url, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return {
      status: 'error',
      url,
      httpStatus: res.status,
      error: `HTTP ${res.status} ${res.statusText}`,
    };
  }

  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('application/json') || url.endsWith('.json')) {
    let text: string;
    try {
      const raw = await res.text();
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = await res.text();
    }
    return { status: 'ok', url, contentType: 'json', text, metadata: {}, links: [], outline: [] };
  }

  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return {
      status: 'error',
      url,
      error: `Unsupported content type: ${(contentType.split(';')[0] ?? '').trim() || 'unknown'}`,
    };
  }

  const rawHtml = await res.text();
  const { document } = parseHTML(rawHtml);

  // Metadata — prefer og: tags then fall back to standard meta/title
  const title =
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ??
    document.querySelector('title')?.textContent?.trim();
  const description =
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    document.querySelector('meta[name="description"]')?.getAttribute('content') ??
    undefined;

  // Links — absolute http(s) only, deduplicated by href, capped at 50
  const linkMap = new Map<string, string>();
  for (const a of document.querySelectorAll('a[href]')) {
    if (linkMap.size >= 50) break;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('http') && !linkMap.has(href)) {
      linkMap.set(href, a.textContent?.trim() ?? '');
    }
  }
  const links = [...linkMap.entries()].map(([href, text]) => ({ text, href }));

  // Heading outline (h1–h3) in DOM order
  const outline: Array<{ level: number; text: string }> = [];
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    const level = parseInt(h.tagName.charAt(1), 10);
    outline.push({ level, text: h.textContent?.trim() ?? '' });
  }

  // Reader-mode body via Readability (mutates the document — run last)
  let text: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const article = new Readability(document as any).parse();
    text = article?.textContent?.trim() ?? '';
  } catch {
    text = '';
  }
  if (!text) {
    text = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  return {
    status: 'ok',
    url,
    contentType: 'html',
    text,
    metadata: { title, description },
    links,
    outline,
  };
}
