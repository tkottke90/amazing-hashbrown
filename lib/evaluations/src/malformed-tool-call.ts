// Detects a tool call the model emitted as plain text instead of a
// structured AIMessage.tool_calls entry, and a clarifying question answered
// in prose instead of an ask_user call. Both are provider/model transport
// failures, not reasoning failures — see
// docs/superpowers/specs/2026-10-03-malformed-tool-call-detection-design.md
// and issue #227. Pure and synchronous: no LangChain imports, so this can be
// unit-tested against plain strings without any model/provider plumbing.

export interface MalformedToolCallMatch {
  parsedToolName: string | null;
  raw: string;
}

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>|<tool_call>([\s\S]*)/i;
const FUNCTION_TAG = /<function=([^>]+)>/i;
const PIPE_TOOL_CALL_TAG = /<\|tool_call\|>([\s\S]*)/i;

// Scans for a '{' and returns the substring up to its balanced closing '}',
// or null if the braces never balance. Needed because a tool call's JSON
// arguments can themselves contain nested objects/braces, so a single regex
// like /\{[^}]*\}/ would stop at the first inner '}' instead of the outer one.
function extractBalancedJsonObjects(content: string): string[] {
  const candidates: string[] = [];
  for (let start = content.indexOf('{'); start !== -1; start = content.indexOf('{', start + 1)) {
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(content.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseNameFromJsonLike(text: string): string | null {
  for (const candidate of extractBalancedJsonObjects(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.name === 'string' &&
        ('arguments' in parsed || 'parameters' in parsed)
      ) {
        return parsed.name;
      }
    } catch {
      // Not valid JSON — keep scanning other balanced-brace candidates.
    }
  }
  return null;
}

export function detectMalformedToolCall(
  content: string,
  knownToolNames: string[],
): MalformedToolCallMatch | null {
  const toolCallTagMatch = content.match(TOOL_CALL_TAG);
  if (toolCallTagMatch) {
    const inner = toolCallTagMatch[1] ?? toolCallTagMatch[2] ?? '';
    const functionMatch = inner.match(FUNCTION_TAG);
    const parsedToolName = functionMatch
      ? (functionMatch[1] ?? '').trim()
      : parseNameFromJsonLike(inner);
    return { parsedToolName, raw: toolCallTagMatch[0] };
  }

  const functionTagMatch = content.match(FUNCTION_TAG);
  if (functionTagMatch) {
    return { parsedToolName: (functionTagMatch[1] ?? '').trim(), raw: functionTagMatch[0] };
  }

  const pipeTagMatch = content.match(PIPE_TOOL_CALL_TAG);
  if (pipeTagMatch) {
    const parsedToolName = parseNameFromJsonLike(pipeTagMatch[1] ?? '');
    return { parsedToolName, raw: pipeTagMatch[0] };
  }

  for (const candidate of extractBalancedJsonObjects(content)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.name === 'string' &&
        ('arguments' in parsed || 'parameters' in parsed)
      ) {
        return { parsedToolName: parsed.name, raw: candidate };
      }
    } catch {
      // Not valid JSON — keep scanning other balanced-brace candidates.
    }
  }

  for (const toolName of knownToolNames) {
    const bareTag = new RegExp(`<${toolName}>([\\s\\S]*?)<\\/${toolName}>`);
    const bareTagMatch = content.match(bareTag);
    if (bareTagMatch) {
      return { parsedToolName: toolName, raw: bareTagMatch[0] };
    }
  }

  return null;
}

const CODE_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

// A reply that is nothing but a JSON object — a tool call's arguments emitted
// as plain text with no tool name at all (e.g. gpt-oss on Ollama returning
// `{"query":"violin","limit":5}` as content, nothing in tool_calls). The shapes
// detectMalformedToolCall knows all name the tool; this one cannot, so
// parsedToolName is null. Kept separate from detectMalformedToolCall because it
// is only safe where a tool call was expected: a bare JSON reply can be a
// legitimate answer to an llm-judge scenario, so the runner applies this in the
// tool-call/tool-sequence branches only. Prose around the object, an array, or
// a bare scalar is not matched.
export function detectArgumentsOnlyToolCall(content: string): MalformedToolCallMatch | null {
  const trimmed = content.trim();
  const body = (CODE_FENCE.exec(trimmed)?.[1] ?? trimmed).trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { parsedToolName: null, raw: body };
    }
  } catch {
    // Not valid JSON — plain prose that happens to start and end with braces.
  }
  return null;
}

export function detectProseQuestion(content: string): boolean {
  const trimmed = content.replace(/[\s*_`]+$/, '').trimEnd();
  return trimmed.length > 0 && trimmed.endsWith('?');
}
