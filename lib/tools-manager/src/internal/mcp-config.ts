import { readFile, writeFile, rename } from 'node:fs/promises';
import type { McpConfigFile } from '../types.js';

export async function readMcpConfig(filePath: string): Promise<McpConfigFile> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return validateShape(JSON.parse(raw));
  } catch {
    return { mcpServers: {} };
  }
}

export async function writeMcpConfig(filePath: string, config: McpConfigFile): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await rename(tmp, filePath);
}

export async function parseMcpSource(source: string | Buffer): Promise<McpConfigFile> {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : await readFile(source, 'utf8');
  return validateShape(JSON.parse(raw));
}

function validateShape(parsed: unknown): McpConfigFile {
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('mcpServers' in parsed) ||
    typeof (parsed as Record<string, unknown>)['mcpServers'] !== 'object' ||
    (parsed as Record<string, unknown>)['mcpServers'] === null
  ) {
    throw new Error('Invalid MCP config: missing or non-object "mcpServers" key');
  }
  return parsed as McpConfigFile;
}
