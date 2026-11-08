import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getToolContent } from '../../services/tool-content-store.js';

function notFoundMessage(threadId: string, toolKey: string): string {
  return (
    `[KV content not found — threadId: ${threadId}, toolKey: ${toolKey}. ` +
    `The content may have expired or belong to a different process.]`
  );
}

const BASE_SCHEMA_SHAPE = {
  threadId: z
    .string()
    .describe(
      'threadId from an actual compact stub already in this conversation, copied verbatim. Do not invent one.',
    ),
  toolKey: z.string().describe('toolKey from that same stub, copied verbatim. Do not invent one.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('0-based index of the first line to return. Omit to start from the beginning.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Maximum number of lines to return starting at offset. Omit to return every remaining line. ' +
        'When you want a bounded slice (not "from here to the end"), pass this alongside offset in ' +
        'the same call — both describe one range together.',
    ),
};

// Rejects anything that isn't a bare filename. path.basename(f) === f alone
// is not sufficient to rule out traversal — path.basename('..') === '..' and
// path.basename('.') === '.' both pass that check despite being
// traversal-relevant — so '.' and '..' are rejected explicitly too.
const FilenameSchema = z
  .string()
  .min(1)
  .refine(
    (f) => f !== '.' && f !== '..' && path.basename(f) === f,
    'filename must not contain path separators or ".."',
  )
  .describe(
    'Optional bare filename (no path separators) to write the (possibly offset/limit-sliced) content ' +
      "into this workspace's .hashbrown/tool-key/ directory instead of getting it back inline. Returns " +
      'a short confirmation with the path and how much was written — read it back later with shell_exec ' +
      'instead of calling get_tool_key again for the same reference.',
  );

const RestrictedSchema = z.object(BASE_SCHEMA_SHAPE);
const FullSchema = RestrictedSchema.extend({ filename: FilenameSchema.optional() });

interface GetToolKeyArgs {
  threadId: string;
  toolKey: string;
  offset: number;
  limit?: number;
  filename?: string;
}

// Pure, isolated line-range slicing — exported for direct unit testing.
// offset:0 with no limit (the default, and the only shape every existing
// caller used before offset/limit existed) returns the stored content
// completely unchanged, so nothing that reads a full stub today regresses.
export function sliceLines(content: string, offset: number, limit?: number): string {
  if (offset === 0 && limit === undefined) return content;

  const lines = content.split('\n');
  const total = lines.length;
  if (offset >= total) {
    return `[No lines at offset ${offset} — this content has ${total} lines.]`;
  }

  const end = limit === undefined ? total : Math.min(offset + limit, total);
  const slice = lines.slice(offset, end).join('\n');
  return `[lines ${offset}-${end - 1} of ${total} total]\n${slice}`;
}

// Writes (possibly sliced) content into a workspace's .hashbrown/tool-key/
// directory, same mkdir-then-writeFile shape as workspace-summarizer.ts's
// .hashbrown/summaries/ write. Overwrites silently — this is agent scratch
// space, same spirit as Task Files' own overwrite-on-rewrite. Never throws:
// a write failure becomes a returned error string, like every other tool in
// this codebase reporting failure as text rather than raising.
export async function writeToolKeyFile(
  workspaceLocation: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = path.join(workspaceLocation, '.hashbrown', 'tool-key');
  const relPath = path.join('.hashbrown', 'tool-key', filename);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), content, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to write ${relPath}: ${message}.`;
  }

  const lines = content === '' ? 0 : content.split('\n').length;
  return (
    `Wrote ${lines} lines (${content.length.toLocaleString()} chars) to ${relPath} — ` +
    `read it back with shell_exec; no need to call get_tool_key again for this reference.`
  );
}

// Shared by both schema variants below — the restricted schema just never
// has a filename to pass through, so there is one implementation, not two.
export async function resolveGetToolKey(
  args: GetToolKeyArgs,
  ctx: { workspaceLocation?: string },
): Promise<string> {
  const stored = getToolContent(args.threadId, args.toolKey);
  if (stored === undefined) return notFoundMessage(args.threadId, args.toolKey);

  const sliced = sliceLines(stored, args.offset, args.limit);

  if (args.filename && ctx.workspaceLocation) {
    return writeToolKeyFile(ctx.workspaceLocation, args.filename, sliced);
  }

  return sliced;
}

function buildDescription(workspaceLocation: string | undefined): string {
  const base =
    'Read back content that was offloaded to the KV store — by web_fetch, when its result was too ' +
    'large to return inline, by an MCP tool call whose result was too large, by the context-window ' +
    'trimmer when a tool result in the current turn had to be truncated to fit, by a large text ' +
    'file the user attached to their message, or by an image the user attached earlier in this ' +
    'conversation — because you need the actual text, or ' +
    'want to look at the image again, for something other than saving it to the wiki. Requires a ' +
    "real threadId and toolKey copied verbatim from that stub's frontmatter (the block starting " +
    '\'── CONTENT OFFLOADED ──\') or from a "(You can re-fetch this image later via get_tool_key(...))" ' +
    'notation. Do not fabricate these values — if there is no stub or notation with a real toolKey ' +
    'in this conversation, there is nothing to exchange; the content already in front of you is ' +
    'everything there is. For an image: call this regardless of whether you believe you can process ' +
    "images yourself — you are not the one deciding that. The system checks the active model's real " +
    'vision capability and either attaches the real image to your next message or tells you plainly ' +
    "it couldn't; declining to call it on your own assumption is always wrong. For wiki ingestion, " +
    'do not call this first — pass corpus:{threadId, toolKey} directly to wiki_create_page, which ' +
    'resolves the reference itself. Optional offset/limit arguments read back a line range instead ' +
    'of the whole thing — omit both for the full content, same as always.';

  if (!workspaceLocation) return base;

  return (
    base +
    ' You also have an optional filename argument: pass a bare filename (no path separators) to ' +
    "write the (possibly offset/limit-sliced) content into this workspace's .hashbrown/tool-key/ " +
    'directory instead of getting it back inline — read it later with shell_exec.'
  );
}

// workspaceLocation present → full schema (adds filename); absent →
// restricted schema with structurally no filename field at all, not just an
// undocumented one. Built per-agent (never a shared module-level constant)
// because the correct shape depends on whether this agent has a workspace —
// the same reason shell_exec is built via makeShellExecTool() instead of
// living in STATIC_CHAT_TOOLS.
export function makeGetToolKeyTool(workspaceLocation?: string) {
  const schema = workspaceLocation ? FullSchema : RestrictedSchema;

  return tool(async (args: GetToolKeyArgs) => resolveGetToolKey(args, { workspaceLocation }), {
    name: 'get_tool_key',
    description: buildDescription(workspaceLocation),
    schema,
  });
}
