import type { ToolCall, RLMConfig, ModelAdapter, RlmEmbeddingAdapter, RLMCorpus } from './types.js';
import { CorpusIndex } from './search.js';
import { buildSubCallPrompt } from './prompts.js';

// Sentinel values returned by terminal tools — runner checks for these.
export const SENTINEL_FINAL = '__rlm_final__';
export const SENTINEL_NOT_FOUND = '__rlm_not_found__';

export class REPLEnvironment {
  private readonly lines: string[];
  private index: CorpusIndex | null = null;
  private embeddingAdapter: RlmEmbeddingAdapter | null = null;
  private readonly corpus: RLMCorpus;
  private readonly config: RLMConfig;
  private readonly subAdapter: ModelAdapter;

  readonly charCount: number;
  readonly lineCount: number;
  readonly source: string | undefined;

  constructor(corpus: RLMCorpus, config: RLMConfig, subAdapter: ModelAdapter) {
    this.corpus = corpus;
    this.config = config;
    this.subAdapter = subAdapter;
    this.lines = corpus.text.split('\n');
    this.charCount = corpus.text.length;
    this.lineCount = this.lines.length;
    this.source = corpus.source;
  }

  async buildIndex(adapter: RlmEmbeddingAdapter): Promise<void> {
    this.embeddingAdapter = adapter;
    this.index = await CorpusIndex.build(this.lines, adapter);
  }

  hasIndex(): boolean {
    return this.index !== null;
  }

  hasProvenance(): boolean {
    return this.corpus.provenance !== undefined;
  }

  async execute(call: ToolCall): Promise<string> {
    switch (call.name) {
      case 'peek':
        return this._peek(call.args);
      case 'grep':
        return this._grep(call.args);
      case 'slice':
        return this._slice(call.args);
      case 'summarize':
        return await this._summarize(call.args);
      case 'query':
        return await this._query(call.args);
      case 'search':
        return await this._search(call.args);
      case 'get_provenance':
        return await this._getProvenance(call.args);
      case 'not_found':
        return SENTINEL_NOT_FOUND;
      case 'final_answer':
        return SENTINEL_FINAL + ((call.args['content'] as string) ?? '');
      default:
        return `Unknown tool: "${call.name}". Available tools: peek, grep, slice, summarize, query, search, not_found, final_answer.`;
    }
  }

  private _peek(args: Record<string, unknown>): string {
    const chars = Math.max(1, Number(args['chars'] ?? 2000));
    return this.corpus.text.slice(0, chars);
  }

  private _grep(args: Record<string, unknown>): string {
    const pattern = String(args['pattern'] ?? '');
    const maxResults = Math.max(1, Number(args['maxResults'] ?? 50));
    const resultCap = maxResults + 1;

    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return `Invalid regex pattern: "${pattern}"`;
    }

    const hits: string[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      if (re.test(this.lines[i] ?? '')) {
        hits.push(`line ${i + 1}: ${this.lines[i]}`);
        if (hits.length >= resultCap) break;
      }
    }

    if (hits.length === 0) return `No matches found for pattern: "${pattern}"`;

    if (hits.length > maxResults) {
      hits.pop();
      return (
        hits.join('\n') +
        `\n\n[Result limit reached (${maxResults}). Try narrowing with a more specific pattern, or use \`summarize\` for large ranges.]`
      );
    }

    return hits.join('\n');
  }

  private _slice(args: Record<string, unknown>): string {
    const startLine = Math.max(1, Number(args['startLine'] ?? 1));
    const endLine = Number(args['endLine'] ?? startLine);
    const lineSpan = endLine - startLine + 1;

    if (lineSpan > this.config.maxSliceLines) {
      return (
        `Requested ${lineSpan} lines, but the limit is ${this.config.maxSliceLines} per call. ` +
        `Use \`summarize(${startLine}, ${endLine})\` to distill this range, or break it into smaller slices.`
      );
    }

    const start = startLine - 1;
    const end = Math.min(endLine, this.lines.length);
    const selected = this.lines.slice(start, end);
    const numbered = selected.map((line, i) => `${startLine + i}: ${line}`);
    return numbered.join('\n');
  }

  private async _summarize(args: Record<string, unknown>): Promise<string> {
    const startLine = Math.max(1, Number(args['startLine'] ?? 1));
    const endLine = Number(args['endLine'] ?? this.lineCount);
    const focus = args['focus'] ? String(args['focus']) : undefined;

    const chunk = this.lines.slice(startLine - 1, endLine).join('\n');

    const systemPrompt = buildSubCallPrompt('summarize', focus);
    const response = await this.subAdapter.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunk },
      ],
      [],
      this.config,
    );

    return response.content;
  }

  private async _query(args: Record<string, unknown>): Promise<string> {
    const question = String(args['question'] ?? '');
    const startLine = Math.max(1, Number(args['startLine'] ?? 1));
    const endLine = Number(args['endLine'] ?? this.lineCount);

    const chunk = this.lines.slice(startLine - 1, endLine).join('\n');

    const systemPrompt = buildSubCallPrompt('query', question);
    const response = await this.subAdapter.complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chunk },
      ],
      [],
      this.config,
    );

    return response.content;
  }

  private async _search(args: Record<string, unknown>): Promise<string> {
    if (!this.index || !this.embeddingAdapter) {
      return 'Semantic search is not available (no embedding adapter configured).';
    }

    const query = String(args['query'] ?? '');
    const topK = Math.max(1, Number(args['topK'] ?? 5));

    const [queryVec] = await this.embeddingAdapter.embed([query]);
    if (!queryVec || queryVec.length === 0) {
      return 'Embedding failed — search unavailable.';
    }

    const results = this.index.search(queryVec, topK);
    if (results.length === 0) {
      return `No semantically similar passages found for: "${query}"`;
    }

    return results
      .map(
        (r, i) =>
          `Result ${i + 1} (lines ${r.startLine}–${r.endLine}):\n${r.text.slice(0, 300)}${r.text.length > 300 ? '…' : ''}`,
      )
      .join('\n\n');
  }

  private async _getProvenance(args: Record<string, unknown>): Promise<string> {
    if (!this.corpus.provenance) {
      return 'Provenance store is not available.';
    }

    const fact = String(args['fact'] ?? '');
    const entries = await this.corpus.provenance.lookup(fact);

    if (entries.length === 0) {
      return `No provenance records found for: "${fact}". Note: lookup uses substring match — paraphrase queries may not match the stored canonical claim text.`;
    }

    return entries
      .map((e) => {
        const writtenAt = new Date(e.writtenAt);
        const ageDays = Math.floor((Date.now() - writtenAt.getTime()) / (1000 * 60 * 60 * 24));
        return [
          `Claim: ${e.claimText}`,
          `Source: ${e.sourceDocId} (${e.sourceType})`,
          `Written: ${e.writtenAt} (${ageDays} days ago)`,
          e.supersededBy ? `Superseded by: ${e.supersededBy}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
  }
}
