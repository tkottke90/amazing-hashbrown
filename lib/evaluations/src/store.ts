import { z } from 'zod';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import {
  EvalRunSchema,
  ScenarioResultSchema,
  JsonOf,
  ScenarioResultDetailsSchema,
  type EvalRun,
  type ScenarioResult,
} from './schemas.js';

// Version 1: ObservabilityStore  Version 2: CostStore  Version 3: EvaluationsStore
const MIGRATIONS: DbMigration[] = [
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS eval_runs (
        run_id              TEXT PRIMARY KEY,
        suite_id            TEXT NOT NULL,
        model               TEXT NOT NULL,
        judge_model         TEXT,
        started_at          TEXT NOT NULL,
        ended_at            TEXT,
        passed              INTEGER NOT NULL,
        pass_rate           REAL NOT NULL,
        total_scenarios     INTEGER NOT NULL,
        passed_scenarios    INTEGER NOT NULL,
        total_latency_ms    INTEGER NOT NULL,
        estimated_cost_usd  REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS eval_results (
        result_id           TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL REFERENCES eval_runs(run_id),
        scenario_id         TEXT NOT NULL,
        suite_id            TEXT NOT NULL,
        type                TEXT NOT NULL,
        passed              INTEGER NOT NULL,
        score               REAL,
        actual_output       TEXT NOT NULL,
        latency_ms          INTEGER NOT NULL,
        estimated_cost_usd  REAL NOT NULL,
        details             TEXT NOT NULL CHECK(json_valid(details))
      );

      CREATE INDEX IF NOT EXISTS idx_eval_results_run    ON eval_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_suite     ON eval_runs(suite_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_started   ON eval_runs(started_at);
    `,
  },
];

// ---------------------------------------------------------------------------
// Raw row schemas — transform snake_case DB columns to camelCase domain types
// ---------------------------------------------------------------------------

const RawEvalRunSchema = z
  .object({
    run_id: z.string(),
    suite_id: z.string(),
    model: z.string(),
    judge_model: z.string().nullable(),
    started_at: z.string(),
    ended_at: z.string().nullable(),
    passed: z.number().transform(Boolean),
    pass_rate: z.number(),
    total_scenarios: z.number(),
    passed_scenarios: z.number(),
    total_latency_ms: z.number(),
    estimated_cost_usd: z.number(),
  })
  .transform((row) => ({
    id: row.run_id,
    suiteId: row.suite_id,
    model: row.model,
    judgeModel: row.judge_model ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    passed: row.passed,
    passRate: row.pass_rate,
    totalScenarios: row.total_scenarios,
    passedScenarios: row.passed_scenarios,
    totalLatencyMs: row.total_latency_ms,
    estimatedCostUsd: row.estimated_cost_usd,
  }));

const RawEvalResultSchema = z
  .object({
    result_id: z.string(),
    run_id: z.string(),
    scenario_id: z.string(),
    suite_id: z.string(),
    type: z.string(),
    passed: z.number().transform(Boolean),
    score: z.number().nullable(),
    actual_output: z.string(),
    latency_ms: z.number(),
    estimated_cost_usd: z.number(),
    details: JsonOf(ScenarioResultDetailsSchema),
  })
  .transform((row) => ({
    id: row.result_id,
    runId: row.run_id,
    scenarioId: row.scenario_id,
    suiteId: row.suite_id,
    passed: row.passed,
    score: row.score,
    actualOutput: row.actual_output,
    latencyMs: row.latency_ms,
    estimatedCostUsd: row.estimated_cost_usd,
    details: row.details,
  }));

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface EvalRunFilters {
  suiteId?: string;
  model?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface HumanResultUpdate {
  status: 'approved' | 'rejected';
  response: string;
  reviewerNotes?: string;
}

// ---------------------------------------------------------------------------
// EvaluationsStore
// ---------------------------------------------------------------------------

export class EvaluationsStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  saveRun(run: EvalRun, results: ScenarioResult[]): void {
    const insertRun = this.db.prepare(
      `INSERT INTO eval_runs
         (run_id, suite_id, model, judge_model, started_at, ended_at,
          passed, pass_rate, total_scenarios, passed_scenarios,
          total_latency_ms, estimated_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertResult = this.db.prepare(
      `INSERT INTO eval_results
         (result_id, run_id, scenario_id, suite_id, type, passed, score,
          actual_output, latency_ms, estimated_cost_usd, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const doSave = this.db.transaction(() => {
      insertRun.run(
        run.id,
        run.suiteId,
        run.model,
        run.judgeModel ?? null,
        run.startedAt,
        run.endedAt ?? null,
        run.passed ? 1 : 0,
        run.passRate,
        run.totalScenarios,
        run.passedScenarios,
        run.totalLatencyMs,
        run.estimatedCostUsd,
      );
      for (const r of results) {
        insertResult.run(
          r.id,
          r.runId,
          r.scenarioId,
          r.suiteId,
          r.details.type,
          r.passed ? 1 : 0,
          r.score,
          r.actualOutput,
          r.latencyMs,
          r.estimatedCostUsd,
          JSON.stringify(r.details),
        );
      }
    });

    doSave();
  }

  updateHumanResult(resultId: string, update: HumanResultUpdate): void {
    this.db
      .prepare(
        `UPDATE eval_results
         SET details = json_set(details,
           '$.status', ?,
           '$.response', ?,
           '$.reviewerNotes', ?)
         WHERE result_id = ?`,
      )
      .run(update.status, update.response, update.reviewerNotes ?? null, resultId);
  }

  findRunById(runId: string): EvalRun | null {
    const row = this.db.prepare('SELECT * FROM eval_runs WHERE run_id = ?').get(runId);
    return row ? EvalRunSchema.parse(RawEvalRunSchema.parse(row)) : null;
  }

  findRuns(filters?: EvalRunFilters): EvalRun[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.suiteId) {
      conditions.push('suite_id = ?');
      values.push(filters.suiteId);
    }
    if (filters?.model) {
      conditions.push('model = ?');
      values.push(filters.model);
    }
    if (filters?.since) {
      conditions.push('started_at >= ?');
      values.push(filters.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM eval_runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all([...values, limit, offset]);

    return rows.map((row) => EvalRunSchema.parse(RawEvalRunSchema.parse(row)));
  }

  findResultsByRunId(runId: string): ScenarioResult[] {
    const rows = this.db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(runId);
    return rows.map((row) => ScenarioResultSchema.parse(RawEvalResultSchema.parse(row)));
  }

  findPendingHumanResults(runId: string): ScenarioResult[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM eval_results
         WHERE run_id = ? AND type = 'human'
           AND json_extract(details, '$.status') = 'pending'`,
      )
      .all(runId);
    return rows.map((row) => ScenarioResultSchema.parse(RawEvalResultSchema.parse(row)));
  }
}

// ---------------------------------------------------------------------------
// Singleton boot/get — shared by bin scripts and the API server
// ---------------------------------------------------------------------------

let _store: EvaluationsStore | null = null;

export function bootEvaluations(db: SqliteDatabase): void {
  _store = new EvaluationsStore(db);
}

export function getEvaluationsStore(): EvaluationsStore {
  if (!_store) throw new Error('EvaluationsStore not initialised — call bootEvaluations() first');
  return _store;
}
