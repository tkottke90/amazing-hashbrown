import { config } from 'dotenv';

config();

export const env = {
  port: Number(process.env.PORT ?? 3000),
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434',
  llmModel: process.env.LLM_MODEL ?? 'llama3',
};
