import { z } from 'zod';
import type {
  InferenceAdapter,
  EmbeddingAdapter,
  ExtendedCompleteOptions,
  InferenceResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from '../types.js';

// --------------------------------------------------------------------------
// OllamaAdapter
// --------------------------------------------------------------------------

interface OllamaAdapterOpts {
  baseUrl: string;
  model: string;
  think?: boolean;
  retryOn5xx?: boolean;
}

// Shape of an Ollama /api/chat response message
interface OllamaChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaChatResponse {
  message: OllamaChatMessage;
}

export class OllamaAdapter implements InferenceAdapter {
  private readonly baseUrl: string;
  readonly model: string;
  private readonly think: boolean;
  private readonly retryOn5xx: boolean;

  constructor(opts: OllamaAdapterOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.think = opts.think ?? false;
    this.retryOn5xx = opts.retryOn5xx ?? true;
  }

  async invoke(messages: Message[], options?: ExtendedCompleteOptions): Promise<InferenceResponse> {
    const tools = options?.tools ?? [];
    const body = {
      model: this.model,
      messages: messages.map(toOllamaMessage),
      tools: tools.length > 0 ? tools.map(toOllamaTool) : undefined,
      stream: false,
      options: {
        temperature: options?.temperature,
        top_p: options?.topP,
        top_k: options?.topK,
        num_predict: options?.maxTokens,
      },
      chat_template_kwargs: { enable_thinking: this.think },
    };

    const raw = await this._post('/api/chat', body);
    const data = raw as OllamaChatResponse;
    const msg = data.message;

    const rawContent = msg.content ?? '';
    const stripped = stripThinkBlocks(rawContent);
    const toolCalls = extractToolCalls(msg, stripped);

    return {
      message: { role: 'assistant', content: stripped },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private async _post(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const attempt = async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`Ollama HTTP ${res.status}: ${text}`), {
          status: res.status,
        });
      }
      return res.json();
    };

    try {
      return await attempt();
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (this.retryOn5xx && status >= 500) {
        return attempt();
      }
      throw err;
    }
  }
}

// --------------------------------------------------------------------------
// OllamaEmbeddingAdapter
// --------------------------------------------------------------------------

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { baseUrl: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama embed HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    return data.embeddings;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function toOllamaMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.results.map((r) => r.content).join('\n') };
  }
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    base['tool_calls'] = m.toolCalls.map((tc) => ({
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return base;
}

function toOllamaTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    },
  };
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Parses tool calls from three observed formats:
//   1. Native Ollama structured tool_calls array (preferred)
//   2. <tool_call>{...}</tool_call> XML escape (Qwen3 under context pressure)
//   3. Bare JSON array [{...}] (Mistral 7B)
function extractToolCalls(msg: OllamaChatMessage, strippedContent: string): ToolCall[] {
  // Format 1: native structured
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return msg.tool_calls.map((tc, i) => ({
      id: `tc_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments ?? {},
    }));
  }

  // Format 2: <tool_call>{...}</tool_call>
  const xmlMatches = strippedContent.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g);
  const xmlCalls: ToolCall[] = [];
  let xmlIdx = 0;
  for (const match of xmlMatches) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (parsed.name) {
        xmlCalls.push({ id: `tc_${xmlIdx++}`, name: parsed.name, arguments: parsed.arguments ?? {} });
      }
    } catch {
      // malformed — skip
    }
  }
  if (xmlCalls.length > 0) return xmlCalls;

  // Format 3: bare JSON array
  const trimmed = strippedContent.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Array<{
        name?: string;
        arguments?: Record<string, unknown>;
      }>;
      if (Array.isArray(arr) && arr.length > 0 && arr[0]?.name) {
        return arr
          .filter((tc) => tc.name)
          .map((tc, i) => ({ id: `tc_${i}`, name: tc.name!, arguments: tc.arguments ?? {} }));
      }
    } catch {
      // not valid JSON
    }
  }

  return [];
}
