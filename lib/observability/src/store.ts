import { z } from 'zod';
import {
  BaseStore,
  type IReadDao,
  type DbMigration,
  type SqliteDatabase,
} from '@tkottke90/llm-common-types/db';
import { SpanTypeSchema } from '@tkottke90/llm-common-types/traces';
import type {
  TraceSummary,
  TraceWithSpans,
  SpanRecord,
  TraceFilters,
} from '@tkottke90/llm-common-types/traces';

// ---------------------------------------------------------------------------
// Types for write operations
// ---------------------------------------------------------------------------

export interface StartTraceParams {
  threadId?: string;
  taskId?: string;
  provider: string;
  model: string;
}

export interface EndTraceParams {
  totalTokens: number;
  totalCostEstimate?: number;
}

// ---------------------------------------------------------------------------
// Zod schemas — parse and transform raw SQLite rows into typed records
// ---------------------------------------------------------------------------

// Used by findById() and find() — the GROUP BY query always returns span counts.
const RawTraceSummarySchema = z
  .object({
    trace_id: z.string(),
    thread_id: z.string().nullable(),
    task_id: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    total_tokens: z.number(),
    total_cost_estimate: z.number().nullable(),
    // COUNT() returns 0 for empty sets; SUM() returns null for empty sets.
    span_count: z.number(),
    llm_call_count: z
      .number()
      .nullable()
      .transform((v) => v ?? 0),
    tool_call_count: z
      .number()
      .nullable()
      .transform((v) => v ?? 0),
  })
  .transform((row) => ({
    traceId: row.trace_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalTokens: row.total_tokens,
    totalCostEstimate: row.total_cost_estimate,
    spanCount: row.span_count,
    llmCallCount: row.llm_call_count,
    toolCallCount: row.tool_call_count,
  }));

// Used by getTrace() — basic trace row without span count aggregates.
const RawTraceRecordSchema = z
  .object({
    trace_id: z.string(),
    thread_id: z.string().nullable(),
    task_id: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    total_tokens: z.number(),
    total_cost_estimate: z.number().nullable(),
  })
  .transform((row) => ({
    traceId: row.trace_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalTokens: row.total_tokens,
    totalCostEstimate: row.total_cost_estimate,
  }));

// Used by getTrace() for the spans array.
const RawSpanSchema = z
  .object({
    span_id: z.string(),
    trace_id: z.string(),
    parent_span_id: z.string().nullable(),
    type: SpanTypeSchema,
    name: z.string(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    latency_ms: z.number().nullable(),
    input_tokens: z.number().nullable(),
    output_tokens: z.number().nullable(),
    output_preview: z.string().nullable(),
    input_preview: z.string().nullable(),
    error: z.string().nullable(),
  })
  .transform((row) => ({
    spanId: row.span_id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id,
    type: row.type,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outputPreview: row.output_preview,
    inputPreview: row.input_preview,
    error: row.error,
  }));

// ---------------------------------------------------------------------------
// DDL migrations
// ---------------------------------------------------------------------------

// Each entry is applied once at startup in ascending version order.
// Version numbers must be unique across ALL features that share this database.
const MIGRATIONS: DbMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS observability_traces (
        trace_id            TEXT PRIMARY KEY,
        thread_id           TEXT,
        task_id             TEXT,
        provider            TEXT NOT NULL,
        model               TEXT NOT NULL,
        started_at          TEXT NOT NULL,
        ended_at            TEXT,
        total_tokens        INTEGER NOT NULL DEFAULT 0,
        total_cost_estimate REAL
      );

      CREATE TABLE IF NOT EXISTS observability_spans (
        span_id         TEXT PRIMARY KEY,
        trace_id        TEXT NOT NULL REFERENCES observability_traces(trace_id),
        parent_span_id  TEXT,
        type            TEXT NOT NULL,
        name            TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        latency_ms      INTEGER,
        input_tokens    INTEGER,
        output_tokens   INTEGER,
        output_preview  TEXT,
        input_preview   TEXT,
        error           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_observability_spans_trace   ON observability_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_observability_traces_thread ON observability_traces(thread_id);
      CREATE INDEX IF NOT EXISTS idx_observability_traces_task   ON observability_traces(task_id);
      CREATE INDEX IF NOT EXISTS idx_observability_traces_time   ON observability_traces(started_at);
    `,
  },
];

// ---------------------------------------------------------------------------
// ObservabilityStore
// ---------------------------------------------------------------------------

export class ObservabilityStore extends BaseStore implements IReadDao<TraceSummary, TraceFilters> {
  // Pass an already-open Database connection (created via openDatabase() from
  // @tkottke90/llm-common-types/db). The constructor applies any pending DDL
  // migrations and returns a ready-to-use store.
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  // ---------------------------------------------------------------------------
  // Write API
  // ---------------------------------------------------------------------------

  // Opens a new trace record for the given thread/task. Returns the traceId.
  // Call this before invoking the agent for a turn.
  startTrace(params: StartTraceParams): string {
    const traceId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO observability_traces (trace_id, thread_id, task_id, provider, model, started_at, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        traceId,
        params.threadId ?? null,
        params.taskId ?? null,
        params.provider,
        params.model,
        new Date().toISOString(),
      );
    return traceId;
  }

  // Closes the trace record with final token counts and optional cost estimate.
  // Call this after the agent turn completes.
  endTrace(traceId: string, params: EndTraceParams): void {
    this.db
      .prepare(
        `UPDATE observability_traces
         SET ended_at = ?, total_tokens = ?, total_cost_estimate = ?
         WHERE trace_id = ?`,
      )
      .run(new Date().toISOString(), params.totalTokens, params.totalCostEstimate ?? null, traceId);
  }

  // Persists a batch of spans in a single transaction. Called by the
  // ObservabilityCallbackHandler after the agent turn completes.
  saveSpans(spans: SpanRecord[]): void {
    if (spans.length === 0) return;

    const insert = this.db.prepare(
      `INSERT INTO observability_spans
         (span_id, trace_id, parent_span_id, type, name,
          started_at, ended_at, latency_ms,
          input_tokens, output_tokens,
          output_preview, input_preview, error)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAll = this.db.transaction((rows: SpanRecord[]) => {
      for (const s of rows) {
        insert.run(
          s.spanId,
          s.traceId,
          s.parentSpanId ?? null,
          s.type,
          s.name,
          s.startedAt,
          s.endedAt ?? null,
          s.latencyMs ?? null,
          s.inputTokens ?? null,
          s.outputTokens ?? null,
          s.outputPreview ?? null,
          s.inputPreview ?? null,
          s.error ?? null,
        );
      }
    });

    insertAll(spans);
  }

  // ---------------------------------------------------------------------------
  // IReadDao implementation — TraceSummary shape (metrics only)
  // ---------------------------------------------------------------------------

  // Returns the TraceSummary for a single trace, or null if not found.
  // Use this for cost display and dashboard widgets.
  findById(traceId: string): TraceSummary | null {
    const row = this.db
      .prepare(
        `SELECT
           t.*,
           COUNT(s.span_id)                                    AS span_count,
           SUM(CASE WHEN s.type = 'llm-call'  THEN 1 ELSE 0 END) AS llm_call_count,
           SUM(CASE WHEN s.type = 'tool-call' THEN 1 ELSE 0 END) AS tool_call_count
         FROM observability_traces t
         LEFT JOIN observability_spans s ON s.trace_id = t.trace_id
         WHERE t.trace_id = ?
         GROUP BY t.trace_id`,
      )
      .get(traceId);

    return row ? RawTraceSummarySchema.parse(row) : null;
  }

  // Returns a list of TraceSummaries, newest first.
  // Use this for the conversation list, dashboard, and cost reports.
  find(filters?: TraceFilters): TraceSummary[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.threadId) {
      conditions.push('t.thread_id = ?');
      values.push(filters.threadId);
    }
    if (filters?.taskId) {
      conditions.push('t.task_id = ?');
      values.push(filters.taskId);
    }
    if (filters?.since) {
      conditions.push('t.started_at >= ?');
      values.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT
           t.*,
           COUNT(s.span_id)                                    AS span_count,
           SUM(CASE WHEN s.type = 'llm-call'  THEN 1 ELSE 0 END) AS llm_call_count,
           SUM(CASE WHEN s.type = 'tool-call' THEN 1 ELSE 0 END) AS tool_call_count
         FROM observability_traces t
         LEFT JOIN observability_spans s ON s.trace_id = t.trace_id
         ${where}
         GROUP BY t.trace_id
         ORDER BY t.started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all([...values, limit, offset]);

    return rows.map((row) => RawTraceSummarySchema.parse(row));
  }

  // ---------------------------------------------------------------------------
  // Extended read — TraceWithSpans shape (full detail)
  // ---------------------------------------------------------------------------

  // Returns the full trace with all spans, or null if not found.
  // Use this for the evaluation harness and trace detail views.
  getTrace(traceId: string): TraceWithSpans | null {
    const traceRow = this.db
      .prepare('SELECT * FROM observability_traces WHERE trace_id = ?')
      .get(traceId);

    if (!traceRow) return null;

    const spanRows = this.db
      .prepare('SELECT * FROM observability_spans WHERE trace_id = ? ORDER BY started_at ASC')
      .all(traceId);

    const trace = RawTraceRecordSchema.parse(traceRow);
    const spans = spanRows.map((row) => RawSpanSchema.parse(row));

    return { ...trace, spans };
  }
}
