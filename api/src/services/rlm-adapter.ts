import type {
  InferenceAdapter,
  InferenceResponse,
  Message,
  BaseCompleteOptions,
  ToolCall,
} from '@tkottke90/inference-adapter';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';

function toLangChainMessages(messages: Message[]): BaseMessage[] {
  const result: BaseMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push(new SystemMessage(msg.content));
    } else if (msg.role === 'user') {
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

export class LangChainInferenceAdapter implements InferenceAdapter {
  constructor(private readonly model: BaseChatModel) {}

  async invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse> {
    const lcMessages = toLangChainMessages(messages);

    if (options?.schema) {
      const structured = this.model.withStructuredOutput(options.schema);
      const result = await structured.invoke(lcMessages);
      return {
        message: { role: 'assistant', content: JSON.stringify(result) },
        structured: result,
      };
    }

    if (options?.tools && options.tools.length > 0) {
      if (!this.model.bindTools) {
        throw new Error(`Model ${this.model.constructor.name} does not support tool binding`);
      }
      const bound = this.model.bindTools(
        options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          schema: t.parameters,
        })),
      );
      const response = await bound.invoke(lcMessages);
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

    const response = await this.model.invoke(lcMessages);
    return {
      message: {
        role: 'assistant',
        content: typeof response.content === 'string' ? response.content : '',
      },
    };
  }
}
