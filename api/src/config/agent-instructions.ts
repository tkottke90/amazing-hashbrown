import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configManager } from './env.js';
import { logger, serializeError } from './logger.js';

const AGENT_MD_FILE = 'AGENT.md';

const DEFAULT_TEMPLATE = `<!--
  AGENT.md — read on every chat turn and appended after the harness's own
  tool-orchestration and behavior guidance. Use this file for tone, style,
  communication preferences, or context about you — it supplements the
  harness prompt, it never overrides its tool orchestration or behavior
  rules.

  This file starts empty (comments like this one are stripped before being
  sent to the model). Anything you add outside a comment block becomes part
  of the system prompt on the next POST /api/v1/settings/reload or restart.

  Example:
  Prefer concise answers. Default to metric units.
-->
`;

function stripComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

let _instructions = '';

// Reads config/AGENT.md, creating it from DEFAULT_TEMPLATE if absent — same
// read-or-create shape as ToolsManager.boot()'s mcp.json handling. Never
// throws: a read/write failure logs a warning and leaves instructions empty,
// matching how an unreachable MCP server at startup is handled.
export async function loadAgentInstructions(configDir?: string): Promise<void> {
  try {
    const dir = configDir ?? configManager.getConfigDir();
    const filePath = join(dir, AGENT_MD_FILE);
    await mkdir(dir, { recursive: true });

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      await writeFile(filePath, DEFAULT_TEMPLATE);
      raw = DEFAULT_TEMPLATE;
    }
    _instructions = stripComments(raw).trim();
  } catch (err) {
    logger.warn('Failed to load AGENT.md — continuing with no user instructions', {
      err: serializeError(err),
    });
    _instructions = '';
  }
}

export function getAgentInstructions(): string {
  return _instructions;
}
