import { ChatOllama } from '@langchain/ollama';
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { env } from '../config/env.js';
import { askUserTool } from './tools/ask-user.tool.js';

const checkpointer = new MemorySaver();

function buildChatAgent() {
  const llm = new ChatOllama({
    model: env.llmModel,
    baseUrl: env.llmBaseUrl,
  });

  return createReactAgent({
    llm,
    tools: [askUserTool],
    checkpointSaver: checkpointer,
  });
}

export type ChatAgent = ReturnType<typeof buildChatAgent>;

let _agent: ChatAgent | undefined;

export function getChatAgent(): ChatAgent {
  _agent ??= buildChatAgent();
  return _agent;
}
