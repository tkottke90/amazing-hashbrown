import { randomBytes, randomUUID } from 'node:crypto';
import type { SpanRecord } from '@tkottke90/llm-common-types/traces';
import { getArtifactMeta, getArtifact, getExtractedText } from '../artifacts/artifact-store.js';
import { resolveVisionCapability } from '../services/provider-factory.js';
import { storeToolContent, storeBinaryToolContent } from '../services/tool-content-store.js';
import { toolStub, STUB_THRESHOLD_CHARS, type StubSection } from './tools/tool-stub.js';
import type { UserMessageAttachment } from './thread-message-writer.js';

// What the attachment-awareness middleware (beforeAgent) does with the
// resolved attachment, applied to the turn's last HumanMessage — see
// attachment-awareness.middleware.ts. `text`/`excluded` both append a string
// to the existing text content; `multimodal` replaces it with a
// text+image content array (today's working vision path, unchanged), plus
// followUpNotation appended alongside it so the agent can re-fetch the same
// image later via get_tool_key (see binary-content-fetch.middleware.ts).
export type AttachmentInjection =
  | { kind: 'text'; notation: string }
  | {
      kind: 'multimodal';
      imageBlock: { type: 'image'; mimeType: string; data: string };
      followUpNotation: string;
    }
  | { kind: 'excluded'; notation: string };

export interface AttachmentResolution {
  // Always persisted to thread_messages via recordUserMessage, regardless
  // of pipeline — this is what makes the upload visible in thread history
  // whether or not the LLM actually received it.
  record: UserMessageAttachment;
  injection: AttachmentInjection;
}

// Pipeline-agnostic: resolves what a turn's attachmentId means for both the
// UI-facing thread record and the LLM-facing message, independent of which
// chat surface (main/workspace/wiki-ingestion) is asking. Each stream
// handler calls this once per turn and threads the result through
// recordUserMessage (record) and the agent's configurable (injection) —
// see docs/superpowers/specs/<phase-1-design>.md.
export async function resolveAttachmentForTurn(
  attachmentId: string | undefined,
  threadId: string,
  providerName: string | undefined,
  modelId: string | undefined,
  checkVision: (
    providerName: string | undefined,
    modelId: string,
  ) => Promise<boolean> = resolveVisionCapability,
): Promise<AttachmentResolution | undefined> {
  if (!attachmentId) return undefined;

  const meta = getArtifactMeta(attachmentId);
  if (!meta) return undefined;

  // Only resolve capability when it's actually decisive — a document that
  // doesn't require vision never needs this (and skips the Ollama
  // live-query network call entirely for the common non-image case).
  const visionGateOk = !meta.requiresVision || (await checkVision(providerName, modelId ?? ''));

  if (!visionGateOk) {
    // Only a real image can be re-fetched later via get_tool_key — the
    // beforeModel injection in binary-content-fetch.middleware.ts knows how
    // to re-attach a raw image, not a scanned/image-only PDF (also
    // requiresVision, but a different re-delivery problem this feature
    // doesn't solve).
    let retryNotation = '';
    if (meta.mimeType.startsWith('image/')) {
      const toolKey = `att_${randomBytes(4).toString('hex')}`;
      storeBinaryToolContent(threadId, toolKey, attachmentId);
      retryNotation = ` If a vision-capable model becomes active later in this conversation, it can be retried via get_tool_key({ threadId: "${threadId}", toolKey: "${toolKey}" }).`;
    }

    return {
      record: {
        id: attachmentId,
        filename: meta.displayFilename,
        mimeType: meta.mimeType,
        included: false,
        exclusionReason: 'vision_unsupported',
      },
      injection: {
        kind: 'excluded',
        notation: `[The user attached "${meta.displayFilename}" (${meta.mimeType}) but it could not be included: the current model does not support image input.${retryNotation}]`,
      },
    };
  }

  if (meta.mimeType.startsWith('image/')) {
    const artifact = await getArtifact(attachmentId);
    if (!artifact) {
      // Corrupted/missing state — meta exists but the bytes don't. Fall
      // back to a plain exclusion notice rather than crash the turn.
      return {
        record: {
          id: attachmentId,
          filename: meta.displayFilename,
          mimeType: meta.mimeType,
          included: false,
          exclusionReason: 'artifact_missing',
        },
        injection: {
          kind: 'excluded',
          notation: `[The user attached "${meta.displayFilename}" but it could not be included: the file is no longer available.]`,
        },
      };
    }
    const toolKey = `att_${randomBytes(4).toString('hex')}`;
    storeBinaryToolContent(threadId, toolKey, attachmentId);

    return {
      record: {
        id: attachmentId,
        filename: meta.displayFilename,
        mimeType: meta.mimeType,
        included: true,
      },
      injection: {
        kind: 'multimodal',
        imageBlock: {
          type: 'image',
          mimeType: meta.mimeType,
          data: artifact.original.toString('base64'),
        },
        followUpNotation: `(You can re-fetch this image later via get_tool_key({ threadId: "${threadId}", toolKey: "${toolKey}" }).)`,
      },
    };
  }

  const extractedText = (await getExtractedText(attachmentId)) ?? '';
  const record: UserMessageAttachment = {
    id: attachmentId,
    filename: meta.displayFilename,
    mimeType: meta.mimeType,
    included: true,
  };

  if (extractedText.length <= STUB_THRESHOLD_CHARS) {
    return {
      record,
      injection: {
        kind: 'text',
        notation: `---\nAttached file "${meta.displayFilename}":\n${extractedText}`,
      },
    };
  }

  // Large attachment — offload to the same KV store/get_tool_key mechanism
  // web_fetch uses, instead of inlining the full text into every turn.
  const toolKey = `att_${randomBytes(4).toString('hex')}`;
  storeToolContent(threadId, toolKey, extractedText);

  const summary = extractedText.slice(0, 300).replace(/\s+/g, ' ').trim();
  const sections: StubSection[] = [
    { name: 'summary', content: summary },
    {
      name: 'to read the full file',
      content: `get_tool_key({ threadId: "${threadId}", toolKey: "${toolKey}" })`,
    },
  ];

  return {
    record,
    injection: {
      kind: 'text',
      notation: toolStub(
        {
          kind: 'attachment',
          filename: meta.displayFilename,
          mimeType: meta.mimeType,
          chars: extractedText.length,
          threadId,
          toolKey,
        },
        sections,
      ),
    },
  };
}

// Shared span shape for the three chat pipelines — see
// docs/superpowers/specs/2026-10-02-chat-attachment-fixes-design.md §6.
export function buildAttachmentSpan(
  traceId: string,
  sentAt: string,
  record: UserMessageAttachment,
): SpanRecord {
  return {
    spanId: randomUUID(),
    traceId,
    parentSpanId: null,
    type: 'attachment',
    name: record.included ? 'attachment-included' : 'attachment-excluded',
    startedAt: sentAt,
    endedAt: sentAt,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    inputPreview: null,
    outputPreview: JSON.stringify({
      artifactId: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      included: record.included,
      ...(record.exclusionReason ? { exclusionReason: record.exclusionReason } : {}),
    }),
    error: null,
  };
}
