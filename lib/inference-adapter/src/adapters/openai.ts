import OpenAI from 'openai';
import { z } from 'zod';
import type { Message } from '../types/message.js';
import type {
  ExtendedCompleteOptions,
  InferenceAdapter,
  InferenceResponse,
} from '../types/inference.js';
import type { ToolDefinition } from '../types/tool.js';

interface OpenAiAdapterConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

function toOpenAiMessages(
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      result.push({ role: 'assistant', content: msg.content });
    } else if (msg.role === 'tool') {
      for (const r of msg.results) {
        result.push({ role: 'tool', content: r.content, tool_call_id: r.id ?? '' });
      }
    }
  }
  return result;
}

function toOpenAiTool(def: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: z.toJSONSchema(def.parameters) as Record<string, unknown>,
    },
  };
}

export class OpenAiInferenceAdapter implements InferenceAdapter {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAiAdapterConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'lemonade',
      baseURL: config.baseUrl,
    });
  }

  async invoke(messages: Message[], options?: ExtendedCompleteOptions): Promise<InferenceResponse> {
    const openAiMessages = toOpenAiMessages(messages);

    if (options?.schema) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: openAiMessages,
        response_format: { type: 'json_object' },
        temperature: options?.temperature,
        top_p: options?.topP,
        max_tokens: options?.maxTokens,
      });
      const content = response.choices[0]?.message?.content ?? '';
      const structured = options.schema.parse(JSON.parse(content)) as unknown;
      return {
        message: { role: 'assistant', content },
        structured,
      };
    }

    if (options?.tools && options.tools.length > 0) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: openAiMessages,
        tools: options.tools.map(toOpenAiTool),
        temperature: options?.temperature,
        top_p: options?.topP,
        max_tokens: options?.maxTokens,
      });
      const choice = response.choices[0]?.message;
      const rawCalls = (choice?.tool_calls ?? []) as Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
      const toolCalls = rawCalls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
      return {
        message: { role: 'assistant', content: choice?.content ?? '' },
        toolCalls,
      };
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openAiMessages,
      temperature: options?.temperature,
      top_p: options?.topP,
      max_tokens: options?.maxTokens,
    });
    return {
      message: {
        role: 'assistant',
        content: response.choices[0]?.message?.content ?? '',
      },
    };
  }
}
