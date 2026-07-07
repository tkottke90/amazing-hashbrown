import { ChatOllama } from '@langchain/ollama';
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Message, ToolCall } from '../types/message.js';
import type {
  ExtendedCompleteOptions,
  InferenceAdapter,
  InferenceResponse,
} from '../types/inference.js';
import type { ToolDefinition } from '../types/tool.js';

interface OllamaAdapterConfig {
  model: string;
  baseUrl?: string;
}

function toLangChainMessages(messages: Message[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push(new HumanMessage(msg.content));
    } else if (msg.role === 'assistant') {
      result.push(new AIMessage(msg.content));
    } else if (msg.role === 'tool') {
      for (const r of msg.results) {
        result.push(new ToolMessage({ content: r.content, tool_call_id: r.id ?? '' }));
      }
    }
  }
  return result;
}

function toToolSchema(def: ToolDefinition) {
  return {
    name: def.name,
    description: def.description,
    schema: def.parameters,
  };
}

export class OllamaInferenceAdapter implements InferenceAdapter {
  private readonly config: OllamaAdapterConfig;

  constructor(config: OllamaAdapterConfig) {
    this.config = config;
  }

  async invoke(messages: Message[], options?: ExtendedCompleteOptions): Promise<InferenceResponse> {
    const model = new ChatOllama({
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      temperature: options?.temperature,
      topP: options?.topP,
      topK: options?.topK,
      numPredict: options?.maxTokens,
    });

    const langchainMessages = toLangChainMessages(messages);

    if (options?.schema) {
      const structured = model.withStructuredOutput(options.schema);
      const result = await structured.invoke(langchainMessages);
      return {
        message: { role: 'assistant', content: JSON.stringify(result) },
        structured: result,
      };
    }

    if (options?.tools && options.tools.length > 0) {
      const bound = model.bindTools(options.tools.map(toToolSchema));
      const response = await bound.invoke(langchainMessages);
      const toolCalls: ToolCall[] = (response.tool_calls ?? []).map((tc) => ({
        id: tc.id ?? '',
        name: tc.name,
        arguments: tc.args as Record<string, unknown>,
      }));
      return {
        message: {
          role: 'assistant',
          content: typeof response.content === 'string' ? response.content : '',
        },
        toolCalls,
      };
    }

    const response = await model.invoke(langchainMessages);
    return {
      message: {
        role: 'assistant',
        content: typeof response.content === 'string' ? response.content : '',
      },
    };
  }
}
