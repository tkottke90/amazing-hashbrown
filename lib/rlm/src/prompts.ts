import type { RLMConfig } from './types.js';

export function buildRootSystemPrompt(
  charCount: number,
  lineCount: number,
  source: string | undefined,
  config: RLMConfig,
): string {
  const sourceLabel = source ? `"${source}"` : 'the corpus';
  const lines = [
    `You are a retrieval assistant. You have access to ${sourceLabel}, a document with ${charCount.toLocaleString()} characters across ${lineCount.toLocaleString()} lines.`,
    '',
    "You CANNOT see the document directly. Use the tools provided to read specific parts of it and find the answer to the user's question.",
    '',
    'TOOLKIT:',
    "- peek(chars): Read the first N characters. Use this first to understand the document's structure.",
    '- grep(pattern, maxResults?): Search for a regex pattern. Returns matching lines with line numbers.',
    '- slice(startLine, endLine): Read a specific line range. Hard limit of ' +
      config.maxSliceLines +
      ' lines per call.',
    '- summarize(startLine, endLine, focus?): Distill a section that is too long to slice. Scoped to the given range only.',
    '- query(question, startLine, endLine): Ask a specific question about a range. Returns NOT FOUND IN THIS RANGE if the answer is absent from that range.',
    '- search(query, topK?): Semantic search by meaning, not keywords. Returns candidate regions with line numbers.',
    '- not_found(searched): Call this when you have exhausted your search and the answer is not in the document. Describe what you searched.',
    '- final_answer(content): Call this when you have the answer. Provide your complete response as the content.',
    '',
    'RULES:',
    '1. Always call peek first to orient yourself before searching.',
    '2. Verify by reading (slice) before answering — do not answer from grep or search results alone.',
    '3. If a region is too large to slice, use summarize.',
    '4. If you cannot find the answer after thorough searching, call not_found — never fabricate.',
    '5. When you have the answer, call final_answer.',
  ];

  if (config.promptAddendum) {
    lines.push('', config.promptAddendum);
  }

  return lines.join('\n');
}

export function buildSubCallPrompt(task: 'summarize' | 'query', focus?: string): string {
  if (task === 'summarize') {
    const constraint = focus
      ? `Focus specifically on: ${focus}`
      : 'Provide a concise summary covering the key points.';
    return [
      'You are a summarization assistant. Summarize the following text excerpt.',
      constraint,
      'If the text does not contain relevant content, say so briefly.',
      'Respond with plain text only.',
    ].join('\n');
  }

  return [
    'You are a question-answering assistant. Answer the question using ONLY the text excerpt provided.',
    focus ? `Question: ${focus}` : '',
    'If the answer is not present in this excerpt, respond with exactly: NOT FOUND IN THIS RANGE',
    'Respond with plain text only.',
  ]
    .filter(Boolean)
    .join('\n');
}
