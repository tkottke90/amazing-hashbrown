export function extractToolResultContent(output: unknown): unknown {
  if (output && typeof output === 'object' && 'content' in output) {
    return (output as { content: unknown }).content;
  }
  return output;
}
