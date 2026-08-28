import path from 'node:path';
import { Router } from 'express';
import type { GraphNode, GraphEdge } from '@tkottke90/llm-wiki';
import { getWikiRegistry } from '../../services/wiki.js';
import {
  streamWikiChatToSse,
  resumeWikiChatToSse,
  retryWikiChatToSse,
  writeSseEvent,
} from '../../agents/wiki-stream-handler.js';
import type { SseWriter } from '../../agents/active-sse-writer.js';
import { getThreadStore } from '../../services/thread-store.js';
import { serializeError } from '../../config/logger.js';
import { wikiUploadRouter } from './wiki-upload.route.js';

export const wikiRouter = Router();

wikiRouter.use('/upload', wikiUploadRouter);

function setSseHeaders(res: import('express').Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// Adapts a raw Express Response into the SseWriter shape writeSseEvent()
// now expects — used only for this route's own catch-block error events.
function toSink(res: import('express').Response): SseWriter {
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// GET /api/v1/wiki/domains
wikiRouter.get('/domains', async (_req, res) => {
  try {
    const registry = await getWikiRegistry();
    const domains = registry.list().map((w) => ({
      id: w.id,
      domain: w.domain,
      tags: w.tags,
    }));
    res.json(domains);
  } catch (err) {
    res.status(503).json({ error: 'Wiki registry unavailable', detail: String(err) });
  }
});

// GET /api/v1/wiki/graph
wikiRouter.get('/graph', async (_req, res) => {
  try {
    const registry = await getWikiRegistry();
    const domains = registry.list();

    const mergedNodes: (GraphNode & { domainId: string })[] = [];
    const mergedEdges: (GraphEdge & { domainId: string })[] = [];
    const METADATA_TYPES = new Set(['index', 'log', 'source']);

    for (const domain of domains) {
      try {
        const wiki = await registry.load(domain.id);
        const graph = await wiki.buildGraph();

        const allowedNodeIds = new Set<string>();
        for (const node of graph.nodes) {
          if (!METADATA_TYPES.has(node.type)) {
            mergedNodes.push({ ...node, domainId: domain.id });
            allowedNodeIds.add(node.id);
          }
        }

        for (const edge of graph.edges) {
          if (allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target)) {
            mergedEdges.push({ ...edge, domainId: domain.id });
          }
        }
      } catch {
        // Skip domains that fail to load — don't let one broken domain fail the whole graph
      }
    }

    res.json({ nodes: mergedNodes, edges: mergedEdges });
  } catch (err) {
    res.status(503).json({ error: 'Wiki registry unavailable', detail: String(err) });
  }
});

// GET /api/v1/wiki/domains/:id/pages
wikiRouter.get('/domains/:id/pages', async (req, res) => {
  const { id } = req.params as { id: string };
  try {
    const registry = await getWikiRegistry();
    let wiki;
    try {
      wiki = await registry.load(id);
    } catch {
      res.status(404).json({ error: `Domain "${id}" not found` });
      return;
    }

    const pages = await wiki.listPages();
    const METADATA_TYPES = new Set(['index', 'log']);
    const content = pages
      .filter((p) => !METADATA_TYPES.has(p.type))
      .map((p) => ({
        filename: p.filename,
        title: p.title,
        type: p.type,
        tags: p.frontmatter.tags ?? [],
        confidence: p.frontmatter.confidence,
        contested: p.frontmatter.contested,
      }));

    res.json(content);
  } catch (err) {
    res.status(503).json({ error: 'Wiki registry unavailable', detail: String(err) });
  }
});

// GET /api/v1/wiki/domains/:id/pages/* — wildcard path
wikiRouter.get('/domains/:id/pages/*', async (req, res) => {
  const { id } = req.params as { id: string };
  // Express v5 stores wildcard segments as an array under key '0'
  const rawSegment = (req.params as unknown as Record<string, string | string[]>)[0];
  const pagePath = Array.isArray(rawSegment) ? rawSegment.join('/') : rawSegment;

  if (!pagePath || pagePath.split('/').some((seg) => seg === '..')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  // Normalize slashes
  const normalizedPath = path.normalize(pagePath).replace(/\\/g, '/');

  try {
    const registry = await getWikiRegistry();
    let wiki;
    try {
      wiki = await registry.load(id);
    } catch {
      res.status(404).json({ error: `Domain "${id}" not found` });
      return;
    }

    try {
      const page = await wiki.readPage(normalizedPath);

      // Build a substitution map for [[wiki-link]] syntax found in the page content.
      // Keys are raw link tokens (e.g. [[entities/foo]] or [[entities/foo|Label]]);
      // values are equivalent standard markdown links pointing to the wiki UI.
      const WIKILINK_RE = /\[\[([^|\]]+)(?:\|([^\]]*))?\]\]/g;
      const LINK_METADATA = new Set(['SCHEMA.md', 'index.md', 'log.md']);
      const links: Record<string, string> = {};
      for (const match of page.content.matchAll(WIKILINK_RE)) {
        const raw = match[0];
        const target = match[1]?.trim();
        if (!target) continue;
        const label = match[2]?.trim();
        const pagePath = target.endsWith('.md') ? target : `${target}.md`;
        if (LINK_METADATA.has(pagePath)) continue;
        const displayText = label || target;
        const url = `/wiki?view=document&domain=${encodeURIComponent(id)}&page=${encodeURIComponent(pagePath)}`;
        links[raw] = `[${displayText}](${url})`;
      }

      res.json({
        filename: page.filename,
        title: page.title,
        type: page.type,
        frontmatter: page.frontmatter,
        content: page.content,
        links,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: `Page "${normalizedPath}" not found` });
        return;
      }
      throw err;
    }
  } catch (err) {
    res.status(503).json({ error: 'Wiki registry unavailable', detail: String(err) });
  }
});

// POST /api/v1/wiki/chat/:threadId
wikiRouter.post('/chat/:threadId', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { content, provider, model } = req.body as {
    content?: string;
    provider?: string;
    model?: string;
  };

  if (!threadId || !content?.trim()) {
    res.status(400).json({ error: 'threadId and content are required' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    req.logger.info('Wiki ingestion inference started', { threadId, provider, model });
    await streamWikiChatToSse(res, threadId, content.trim(), startedAt, provider, model);
  } catch (err) {
    req.logger.error('Wiki chat stream error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    req.logger.info('Wiki ingestion inference completed', { threadId });
    res.end();
  }
});

// POST /api/v1/wiki/chat/:threadId/hitl
wikiRouter.post('/chat/:threadId/hitl', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { promptId, answer, provider, model } = req.body as {
    promptId?: string;
    answer?: string;
    provider?: string;
    model?: string;
  };

  if (!threadId || answer === undefined || !promptId) {
    res.status(400).json({ error: 'threadId, promptId, and answer are required' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    await resumeWikiChatToSse(res, threadId, promptId, answer, startedAt, provider, model);
  } catch (err) {
    req.logger.error('Wiki HITL resume error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});

// POST /api/v1/wiki/chat/:threadId/retry
wikiRouter.post('/chat/:threadId/retry', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { provider, model } = req.body as {
    provider?: string;
    model?: string;
  };

  if (!threadId) {
    res.status(400).json({ error: 'threadId is required' });
    return;
  }

  if (!getThreadStore().resolveRetryTarget(threadId)) {
    res.status(400).json({ error: 'Thread has no retryable (failed) turn' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    await retryWikiChatToSse(res, threadId, startedAt, provider, model);
  } catch (err) {
    req.logger.error('Wiki retry stream error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});
