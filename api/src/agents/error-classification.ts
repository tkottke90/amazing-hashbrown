import type { ChatErrorCategory } from '@tkottke90/llm-common-types/chat';
import type { ProviderConfig } from '../config/env.js';

// Maps a thrown turn-ending error to one of the user-facing categories the
// chat UI renders instead of a generic "Something went wrong" message — see
// docs/superpowers/specs/2026-09-08-chat-error-classification-design.md.
// Never throws: any error shape this doesn't recognize (including a
// non-Error thrown value) resolves to 'unknown' rather than propagating.

export interface ClassifiedChatError {
  category: ChatErrorCategory;
  message: string;
}

// Anthropic/OpenAI SDK errors carry a numeric `status`; Ollama's
// ResponseError carries `status_code` instead. Both are read loosely here
// since `err` is `unknown` at every call site.
interface LooseApiError {
  status?: number;
  status_code?: number;
  type?: string;
  code?: string | null;
  name?: string;
  message?: string;
  cause?: { code?: string };
}

// stream-handler.ts's PipeEventsError wraps anything thrown mid-stream and
// keeps the original on `sourceError` — classify that, not the wrapper, which
// has lost the SDK's status/type/code fields. Duck-typed rather than an
// instanceof check so this module doesn't import stream-handler.ts (which
// imports this one).
function unwrapSourceError(err: unknown): unknown {
  if (err instanceof Error && 'sourceError' in err) {
    return (err as { sourceError: unknown }).sourceError;
  }
  return err;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Connection-level failures happen regardless of which provider threw them
// (a local Ollama server that isn't running, a network drop mid-request to
// Anthropic/OpenAI) — checked before any provider-specific matcher.
function classifyNetworkError(err: unknown): ChatErrorCategory | null {
  const e = err as LooseApiError;
  if (e && (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError')) {
    return 'network';
  }
  const code = e?.cause?.code ?? (err as { code?: string } | undefined)?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return 'network';
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return 'network';
  }
  return null;
}

// Anthropic's APIError normalizes the response body's `error.type` onto the
// error instance itself (e.g. 'rate_limit_error', 'billing_error') — see
// @anthropic-ai/sdk's error.d.ts/resources/shared.d.ts ErrorType union.
function classifyAnthropicError(err: unknown): ChatErrorCategory {
  const e = err as LooseApiError;
  const { status, type } = e;
  const message = e.message ?? '';

  if (
    type === 'authentication_error' ||
    type === 'permission_error' ||
    status === 401 ||
    status === 403
  ) {
    return 'auth';
  }
  if (type === 'billing_error') return 'billing';
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (type === 'overloaded_error' || type === 'timeout_error') return 'unavailable';
  if (type === 'not_found_error' || status === 404) return 'unavailable';
  if (type === 'invalid_request_error' || status === 400) {
    if (/context|too long|maximum.*(tokens|context)/i.test(message)) return 'context_length';
    if (/content policy|flagged|declined|cannot assist/i.test(message)) return 'content_policy';
    return 'unknown';
  }
  if (type === 'api_error' || (status !== undefined && status >= 500)) return 'unavailable';
  return 'unknown';
}

// OpenAI's APIError exposes `.status` and `.code` (the response body's
// documented error codes, e.g. 'insufficient_quota', 'context_length_exceeded',
// 'content_policy_violation') directly on the instance.
function classifyOpenAIError(err: unknown): ChatErrorCategory {
  const e = err as LooseApiError;
  const { status, code } = e;

  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return code === 'insufficient_quota' ? 'billing' : 'rate_limit';
  if (status === 400 && code === 'context_length_exceeded') return 'context_length';
  if (status === 400 && code === 'content_policy_violation') return 'content_policy';
  if (status === 404) return 'unavailable';
  if (status !== undefined && status >= 500) return 'unavailable';
  return 'unknown';
}

// Ollama is a local server — auth/billing/rate-limit don't apply. Its
// ResponseError carries `status_code` (not `status`) and a plain message.
function classifyOllamaError(err: unknown): ChatErrorCategory {
  const e = err as LooseApiError;
  const message = e.message ?? '';

  if (e.status_code === 404 || /model .* not found/i.test(message)) return 'unavailable';
  return 'unknown';
}

// Takes the provider's `type` (the SDK family), never its configured `name` —
// a user-named provider (e.g. an OpenAI-compatible endpoint named "glm")
// still throws that SDK's error shape. Typed as the enum so passing a name
// is a compile error rather than a silent fall-through to 'unknown'.
export function classifyChatError(
  err: unknown,
  providerType?: ProviderConfig['type'],
): ClassifiedChatError {
  const source = unwrapSourceError(err);
  const message = messageOf(source);
  const networkCategory = classifyNetworkError(source);
  if (networkCategory) return { category: networkCategory, message };

  switch (providerType) {
    case 'anthropic':
      return { category: classifyAnthropicError(source), message };
    case 'openai':
      return { category: classifyOpenAIError(source), message };
    case 'ollama':
      return { category: classifyOllamaError(source), message };
    default:
      return { category: 'unknown', message };
  }
}
