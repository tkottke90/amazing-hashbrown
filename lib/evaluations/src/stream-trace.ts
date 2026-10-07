// Pure helpers behind bin/eval-stream-trace.ts: turn a model's streamed
// chunks into a flat trace, find the longest run of identical consecutive
// chunks, and render what a failed stream was emitting. Exists because Ollama
// can abort a generation with "token repeat limit reached" and the
// non-streaming path the eval normally uses throws that error away along with
// everything the model had produced — so what was repeating is never visible.
// No LangChain imports: chunks are read structurally, so this is testable
// against plain objects.

export type TraceChannel = 'content' | 'reasoning' | 'tool_call';

export interface TraceChunk {
  channel: TraceChannel;
  text: string;
}

export interface RepeatRun {
  channel: TraceChannel;
  // The whitespace-trimmed chunk text that repeated. Empty string means the
  // model was emitting whitespace-only chunks (spaces/newlines), which a
  // trimming repeat detector counts as one repeated token.
  trimmedText: string;
  // Raw text of the first chunk in the run, so whitespace stays visible.
  sampleText: string;
  length: number;
  // Index into the full trace array of the run's first chunk.
  startIndex: number;
}

// The structural subset of an AIMessageChunk this reads. content may be a
// string or an array of content blocks depending on the provider.
export interface StreamedChunkLike {
  content?: unknown;
  additional_kwargs?: { reasoning_content?: unknown };
  tool_call_chunks?: Array<{ name?: string | null; args?: string | null }>;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('');
}

// One streamed chunk can carry text in several channels at once, so it maps
// to zero or more trace entries. Empty channels are omitted.
export function toTraceChunks(chunk: StreamedChunkLike): TraceChunk[] {
  const out: TraceChunk[] = [];
  const reasoning = chunk.additional_kwargs?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning !== '') {
    out.push({ channel: 'reasoning', text: reasoning });
  }
  const content = contentText(chunk.content);
  if (content !== '') out.push({ channel: 'content', text: content });
  for (const call of chunk.tool_call_chunks ?? []) {
    const text = `${call.name ?? ''}${call.args ?? ''}`;
    if (text !== '') out.push({ channel: 'tool_call', text });
  }
  return out;
}

// Longest run of identical consecutive chunks within one channel, comparing
// whitespace-trimmed text (mirrors how Ollama counts a "repeated token").
// Channels are tracked independently: a reasoning chunk between two content
// chunks does not break the content run. Null for an empty trace.
export function longestRepeatRun(chunks: TraceChunk[]): RepeatRun | null {
  let best: RepeatRun | null = null;
  const current = new Map<TraceChannel, RepeatRun>();
  chunks.forEach((chunk, index) => {
    const trimmed = chunk.text.trim();
    const run = current.get(chunk.channel);
    if (run && run.trimmedText === trimmed) {
      run.length += 1;
    } else {
      current.set(chunk.channel, {
        channel: chunk.channel,
        trimmedText: trimmed,
        sampleText: chunk.text,
        length: 1,
        startIndex: index,
      });
    }
    const latest = current.get(chunk.channel)!;
    if (!best || latest.length > best.length) best = { ...latest };
  });
  return best;
}

export interface StreamTraceSummary {
  totalChunks: number;
  perChannel: Record<TraceChannel, { chunks: number; chars: number }>;
  longestRun: RepeatRun | null;
}

export function summarizeStreamTrace(chunks: TraceChunk[]): StreamTraceSummary {
  const perChannel: StreamTraceSummary['perChannel'] = {
    content: { chunks: 0, chars: 0 },
    reasoning: { chunks: 0, chars: 0 },
    tool_call: { chunks: 0, chars: 0 },
  };
  for (const chunk of chunks) {
    perChannel[chunk.channel].chunks += 1;
    perChannel[chunk.channel].chars += chunk.text.length;
  }
  return { totalChunks: chunks.length, perChannel, longestRun: longestRepeatRun(chunks) };
}

interface CollapsedLine {
  channel: TraceChannel;
  text: string;
  firstIndex: number;
  count: number;
}

// Adjacent chunks with the same channel and exact text fold into one line, so
// a 100-chunk repeat prints as a single `×100` row instead of flooding the tail.
function collapse(chunks: TraceChunk[], from: number): CollapsedLine[] {
  const lines: CollapsedLine[] = [];
  for (let i = from; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const last = lines[lines.length - 1];
    if (last && last.channel === chunk.channel && last.text === chunk.text) {
      last.count += 1;
    } else {
      lines.push({ channel: chunk.channel, text: chunk.text, firstIndex: i, count: 1 });
    }
  }
  return lines;
}

function channelText(chunks: TraceChunk[], channel: TraceChannel): string {
  return chunks
    .filter((c) => c.channel === channel)
    .map((c) => c.text)
    .join('');
}

export interface FormatOptions {
  // Collapsed rows to show from the end of the stream. Default 25.
  tailLines?: number;
  // Characters of same-channel text shown from just before the repeat. Default 300.
  leadInChars?: number;
}

export function formatStreamTrace(chunks: TraceChunk[], options: FormatOptions = {}): string {
  const tailLines = options.tailLines ?? 25;
  const leadInChars = options.leadInChars ?? 300;
  const summary = summarizeStreamTrace(chunks);
  const out: string[] = [];

  const { content, reasoning, tool_call } = summary.perChannel;
  out.push(
    `Streamed ${summary.totalChunks} chunks — content ${content.chunks} (${content.chars} chars), ` +
      `reasoning ${reasoning.chunks} (${reasoning.chars} chars), ` +
      `tool_call ${tool_call.chunks} (${tool_call.chars} chars)`,
  );

  const run = summary.longestRun;
  if (run) {
    const shown = run.trimmedText === '' ? '(whitespace only)' : JSON.stringify(run.trimmedText);
    out.push(
      `Longest repeat: ${run.length} consecutive "${run.channel}" chunks of ${shown} ` +
        `(raw first chunk ${JSON.stringify(run.sampleText)}), starting at chunk #${run.startIndex}`,
    );
    const before = channelText(chunks.slice(0, run.startIndex), run.channel);
    if (before !== '') {
      out.push(`${run.channel} text just before the repeat:`);
      out.push(`  ${JSON.stringify(before.slice(-leadInChars))}`);
    }
  }

  const lines = collapse(chunks, 0);
  const tail = lines.slice(-tailLines);
  out.push(`Last ${tail.length} chunk groups (of ${lines.length}):`);
  for (const line of tail) {
    const range =
      line.count > 1
        ? `#${line.firstIndex}..#${line.firstIndex + line.count - 1} ×${line.count}`
        : `#${line.firstIndex}`;
    out.push(`  ${range} [${line.channel}] ${JSON.stringify(line.text)}`);
  }
  return out.join('\n');
}
