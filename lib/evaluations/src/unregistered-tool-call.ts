// Finds tool calls whose name is not any registered tool — e.g. gpt-oss on
// Ollama occasionally emits `wiki_search?` (a stray trailing `?`) where
// `wiki_search` was meant. The provider passes the name through unchanged
// (Ollama logs "harmony parser: no reverse mapping found for function name"),
// so the harness sees a structurally valid tool call to a tool that does not
// exist. Left unlabelled it reads as "the model chose the wrong tool", which
// hides a model/provider output-format defect behind a reasoning failure.
// Pure and synchronous, like malformed-tool-call.ts: no LangChain imports.

// `registeredToolNames` must be the full harness catalog, not the subset bound
// for one scenario — a real tool hidden by excludeTools/skill gating is a
// different situation (the model called something that does exist) and is not
// "unregistered". An empty catalog means we cannot tell, so nothing is flagged
// rather than every call.
export function detectUnregisteredToolCalls(
  calledToolNames: string[],
  registeredToolNames: string[],
): string[] {
  if (registeredToolNames.length === 0) return [];
  const registered = new Set(registeredToolNames);
  return [...new Set(calledToolNames.filter((name) => !registered.has(name)))];
}
