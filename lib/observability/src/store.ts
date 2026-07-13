import Database from 'better-sqlite3';
import type { IReadDao, DbMigration } from '@tkottke90/llm-common-types/db';
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
// DDL migrations
// ---------------------------------------------------------------------------

// Each entry is applied once at startup in ascending version order.
// When adding new tables to the shared database (e.g. for the Task System),
// add a new entry with the next version number. Version numbers must be unique
// across all features that share this database.
const MIGRATIONS: DbMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS traces (
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

      CREATE TABLE IF NOT EXISTS spans (
        span_id         TEXT PRIMARY KEY,
        trace_id        TEXT NOT NULL REFERENCES traces(trace_id),
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

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_spans_trace   ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_thread ON traces(thread_id);
      CREATE INDEX IF NOT EXISTS idx_traces_task   ON traces(task_id);
      CREATE INDEX IF NOT EXISTS idx_traces_time   ON traces(started_at);
    `,
  },
];

// ---------------------------------------------------------------------------
// ObservabilityStore
// ---------------------------------------------------------------------------

export class ObservabilityStore implements IReadDao<TraceSummary, TraceFilters> {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  // Opens (or creates) the SQLite database at dbPath and applies any pending migrations.
  // Safe to call on every startup — migrations are idempotent.
  static open(dbPath: string): ObservabilityStore {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL'); // better concurrent read performance
    db.pragma('foreign_keys = ON');
    const store = new ObservabilityStore(db);
    store.migrate();
    return store;
  }

  private migrate(): void {
    // schema_migrations may not exist yet on the very first run; create it first.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );
    `);

    const applied = new Set<number>(
      (
        this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version: number;
        }>
      ).map((r) => r.version),
    );

    const insertMigration = this.db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec(migration.sql);
      insertMigration.run(migration.version, new Date().toISOString());
    }
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
        `INSERT INTO traces (trace_id, thread_id, task_id, provider, model, started_at, total_tokens)
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
        `UPDATE traces
         SET ended_at = ?, total_tokens = ?, total_cost_estimate = ?
         WHERE trace_id = ?`,
      )
      .run(
        new Date().toISOString(),
        params.totalTokens,
        params.totalCostEstimate ?? null,
        traceId,
      );
  }

  // Persists a batch of spans in a single transaction. Called by the
  // ObservabilityCallbackHandler after the agent turn completes.
  saveSpans(spans: SpanRecord[]): void {
    if (spans.length === 0) return;

    const insert = this.db.prepare(
      `INSERT INTO spans
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
         FROM traces t
         LEFT JOIN spans s ON s.trace_id = t.trace_id
         WHERE t.trace_id = ?
         GROUP BY t.trace_id`,
      )
      .get(traceId) as RawTraceRow | undefined;

    return row ? rowToSummary(row) : null;
  }

  // Returns a list of TraceSummaries, newest first.
  // Use this for the conversation list, dashboard, and cost reports.
  list(filters?: TraceFilters): TraceSummary[] {
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
         FROM traces t
         LEFT JOIN spans s ON s.trace_id = t.trace_id
         ${where}
         GROUP BY t.trace_id
         ORDER BY t.started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all([...values, limit, offset]) as RawTraceRow[];

    return rows.map(rowToSummary);
  }

  // ---------------------------------------------------------------------------
  // Extended read — TraceWithSpans shape (full detail)
  // ---------------------------------------------------------------------------

  // Returns the full trace with all spans, or null if not found.
  // Use this for the evaluation harness and trace detail views.
  getTrace(traceId: string): TraceWithSpans | null {
    const trace = this.db
      .prepare('SELECT * FROM traces WHERE trace_id = ?')
      .get(traceId) as RawTraceRow | undefined;

    if (!trace) return null;

    const spans = this.db
      .prepare('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC')
      .all(traceId) as RawSpanRow[];

    return {
      traceId: trace.trace_id,
      threadId: trace.thread_id,
      taskId: trace.task_id,
      provider: trace.provider,
      model: trace.model,
      startedAt: trace.started_at,
      endedAt: trace.ended_at,
      totalTokens: trace.total_tokens,
      totalCostEstimate: trace.total_cost_estimate,
      spans: spans.map(rowToSpan),
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row mappers — translate snake_case DB columns to camelCase types
// ---------------------------------------------------------------------------

interface RawTraceRow {
  trace_id: string;
  thread_id: string | null;
  task_id: string | null;
  provider: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  total_tokens: number;
  total_cost_estimate: number | null;
  // Only present in summary queries (LEFT JOIN + GROUP BY)
  span_count?: number;
  llm_call_count?: number;
  tool_call_count?: number;
}

interface RawSpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  type: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  output_preview: string | null;
  input_preview: string | null;
  error: string | null;
}

function rowToSummary(row: RawTraceRow): TraceSummary {
  return {
    traceId: row.trace_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalTokens: row.total_tokens,
    totalCostEstimate: row.total_cost_estimate,
    spanCount: row.span_count ?? 0,
    llmCallCount: row.llm_call_count ?? 0,
    toolCallCount: row.tool_call_count ?? 0,
  };
}

function rowToSpan(row: RawSpanRow): SpanRecord {
  return {
    spanId: row.span_id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id,
    type: row.type as SpanRecord['type'],
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outputPreview: row.output_preview,
    inputPreview: row.input_preview,
    error: row.error,
  };
}
