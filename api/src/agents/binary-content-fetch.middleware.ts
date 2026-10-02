import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'langchain';
import { Command } from '@langchain/langgraph';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getToolContentEntry } from '../services/tool-content-store.js';
import { getArtifact, getArtifactMeta } from '../artifacts/artifact-store.js';
import { resolveVisionCapability } from '../services/provider-factory.js';
import { getAfterAgentContextSchema } from './after-agent.js';
import { getObservabilityStore } from '../services/observability.js';
import { buildAttachmentSpan } from './attachment-resolution.js';

export const binaryContentFetchStateSchema = z.object({
  pendingImageFetch: z.object({ attachmentId: z.string() }).nullable().default(null),
});

// Extends the get_tool_key on-demand pattern (tool-content-store.ts,
// get-tool-key.tool.ts) to binary (image) content — see issue #255 and
// docs/research/langchain-js-tool-call-image-content.md.
//
// get-tool-key.tool.ts itself is untouched: this middleware intercepts the
// call before the real tool ever runs (wrapToolCall short-circuits it,
// confirmed from langchain's own ToolNode.cjs source — not calling `handler`
// skips invokableTool.invoke() entirely, which also means the usual
// automatic 'tool-call' observability span never fires for this call, hence
// the explicit saveSpans below), and defers the actual image delivery to
// beforeModel, which is the one hook every provider integration handles
// correctly for a HumanMessage carrying an image block — the same mechanism
// attachment-awareness.middleware.ts already uses for the initial-attach
// case. A tool's own ToolMessage return value cannot reliably carry an
// image cross-provider (see the research doc), which is why the handoff
// goes through state (`pendingImageFetch`) instead.
export function createBinaryContentFetchMiddleware(checkVision = resolveVisionCapability) {
  return createMiddleware({
    name: 'BinaryContentFetchMiddleware',
    stateSchema: binaryContentFetchStateSchema,
    contextSchema: getAfterAgentContextSchema(),
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== 'get_tool_key') return handler(request);

      const { threadId, toolKey } = (request.toolCall.args ?? {}) as {
        threadId?: string;
        toolKey?: string;
      };
      const entry = threadId && toolKey ? getToolContentEntry(threadId, toolKey) : undefined;
      // Not found, or a text entry — pass through to the real tool
      // unchanged. Zero behavior change for the existing text-offload path.
      if (!entry || entry.kind === 'text') return handler(request);

      const provider = request.runtime.context?.provider;
      const model = request.runtime.context?.model;
      const visionCapable = await checkVision(provider, model ?? '');

      const traceId = request.runtime.configurable?.trace_id as string | undefined;
      if (traceId) {
        const artifactMeta = getArtifactMeta(entry.attachmentId);
        void getObservabilityStore().saveSpans([
          buildAttachmentSpan(traceId, new Date().toISOString(), {
            id: entry.attachmentId,
            filename: artifactMeta?.displayFilename ?? entry.attachmentId,
            mimeType: artifactMeta?.mimeType ?? '',
            included: visionCapable,
            ...(visionCapable ? {} : { exclusionReason: 'vision_unsupported' as const }),
          }),
        ]);
      }

      if (!visionCapable) {
        return new ToolMessage({
          content:
            'The current model does not support image input, so this image cannot be re-fetched right now.',
          tool_call_id: request.toolCall.id ?? randomUUID(),
          name: 'get_tool_key',
        });
      }

      return new Command({
        update: {
          pendingImageFetch: { attachmentId: entry.attachmentId },
          messages: [
            new ToolMessage({
              content: 'Image located — it will be attached to your next message.',
              tool_call_id: request.toolCall.id ?? randomUUID(),
              name: 'get_tool_key',
            }),
          ],
        },
      });
    },
    beforeModel: async (state) => {
      const pending = state.pendingImageFetch;
      if (!pending) return undefined;

      const artifact = await getArtifact(pending.attachmentId);
      if (!artifact) {
        return {
          pendingImageFetch: null,
          messages: [
            ...state.messages,
            new HumanMessage(
              '[The previously attached image could not be re-fetched: the file is no longer available.]',
            ),
          ],
        };
      }

      return {
        pendingImageFetch: null,
        messages: [
          ...state.messages,
          new HumanMessage({
            content: [
              { type: 'text', text: 'Here is the image you asked to see again:' },
              {
                type: 'image',
                mimeType: artifact.mimeType,
                data: artifact.original.toString('base64'),
              },
            ],
          }),
        ],
      };
    },
  });
}

export const binaryContentFetchMiddleware = createBinaryContentFetchMiddleware();
