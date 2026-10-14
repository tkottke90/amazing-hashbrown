/**
 * @tkottke90/llm-wiki — mechanical layer for building and maintaining an
 * LLM Wiki (Karpathy's pattern). Deterministic, framework-agnostic tools a
 * future inference layer can call without knowing their internal steps.
 */

export { LlmWiki } from './llm-wiki.js';
export type {
  BuildGraphOptions,
  CreateOptions,
  LoadOptions,
  SaveRawOptions,
  IngestPrepInput,
} from './llm-wiki.js';

export { WikiRegistry, createWikiRegistry } from './registry.js';
export type { CreateWikiRegistryOptions, CreateWikiInput } from './registry.js';

export * from './types.js';

// Cross-wiki reference parsing ("<wiki-id>:<path>"), used by callers that
// need to resolve such a reference themselves (e.g. api/'s wiki_add_cross_link tool).
export { parseExternalRef } from './internal/wikilinks.js';
