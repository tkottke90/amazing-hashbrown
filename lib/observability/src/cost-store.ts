import { z } from 'zod';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';

// ---------------------------------------------------------------------------
// Types and schemas
// ---------------------------------------------------------------------------

const RawProviderCostSchema = z
  .object({
    id: z.number(),
    provider_name: z.string(),
    model: z.string(),
    input_per_1k_tokens: z.number(),
    output_per_1k_tokens: z.number(),
    config_hash: z.string(),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
  })
  .transform((row) => ({
    id: row.id,
    providerName: row.provider_name,
    model: row.model,
    inputPer1kTokens: row.input_per_1k_tokens,
    outputPer1kTokens: row.output_per_1k_tokens,
    configHash: row.config_hash,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  }));

export type ProviderCostRecord = z.output<typeof RawProviderCostSchema>;

export interface InsertCostRecord {
  providerName: string;
  model: string;
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  configHash: string;
  validFrom: string;
}

const RawUsageRowSchema = z
  .object({
    date: z.string(),
    provider: z.string(),
    model: z.string(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    // SUM over an empty set returns null; coerce to 0
    estimated_cost: z
      .number()
      .nullable()
      .transform((v) => v ?? 0),
  })
  .transform((row) => ({
    date: row.date,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCost: row.estimated_cost,
  }));

export type UsageRow = z.output<typeof RawUsageRowSchema>;

export interface UsageFilters {
  from: string;
  to: string;
  provider?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// DDL migrations
// ---------------------------------------------------------------------------

// Version 2 — ObservabilityStore owns version 1.
// If v_usage ever needs to change, add a new migration that drops and recreates
// the view; CREATE VIEW IF NOT EXISTS will silently keep the old definition.
const MIGRATIONS: DbMigration[] = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS provider_costs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_name        TEXT NOT NULL,
        model                TEXT NOT NULL,
        input_per_1k_tokens  REAL NOT NULL DEFAULT 0,
        output_per_1k_tokens REAL NOT NULL DEFAULT 0,
        config_hash          TEXT NOT NULL,
        valid_from           TEXT NOT NULL,
        valid_until          TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_provider_costs_lookup
        ON provider_costs(provider_name, model, valid_until);

      CREATE VIEW IF NOT EXISTS v_usage AS
      SELECT
        date(s.started_at)                                             AS date,
        t.provider,
        t.model,
        SUM(COALESCE(s.input_tokens,  0))                             AS input_tokens,
        SUM(COALESCE(s.output_tokens, 0))                             AS output_tokens,
        SUM(
          COALESCE(s.input_tokens,  0) / 1000.0 * COALESCE(pc.input_per_1k_tokens,  0) +
          COALESCE(s.output_tokens, 0) / 1000.0 * COALESCE(pc.output_per_1k_tokens, 0)
        )                                                              AS estimated_cost
      FROM observability_spans s
      JOIN observability_traces t ON s.trace_id = t.trace_id
      LEFT JOIN provider_costs pc
        ON  pc.provider_name = t.provider
        AND pc.model         = t.model
        AND s.started_at    >= pc.valid_from
        AND (pc.valid_until IS NULL OR s.started_at < pc.valid_until)
      WHERE s.type = 'llm-call'
      GROUP BY date(s.started_at), t.provider, t.model;
    `,
  },
];

// ---------------------------------------------------------------------------
// CostStore
// ---------------------------------------------------------------------------

export class CostStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  getActiveCosts(): ProviderCostRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_costs WHERE valid_until IS NULL')
      .all() as unknown[];
    return rows.map((r) => RawProviderCostSchema.parse(r));
  }

  closeCostRecord(id: number, until: string): void {
    this.db.prepare('UPDATE provider_costs SET valid_until = ? WHERE id = ?').run(until, id);
  }

  insertCostRecord(record: InsertCostRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_costs
           (provider_name, model, input_per_1k_tokens, output_per_1k_tokens, config_hash, valid_from)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.providerName,
        record.model,
        record.inputPer1kTokens,
        record.outputPer1kTokens,
        record.configHash,
        record.validFrom,
      );
  }

  queryUsage(filters: UsageFilters): UsageRow[] {
    const conditions: string[] = ['date BETWEEN ? AND ?'];
    const params: unknown[] = [filters.from, filters.to];

    if (filters.provider) {
      conditions.push('provider = ?');
      params.push(filters.provider);
    }
    if (filters.model) {
      conditions.push('model = ?');
      params.push(filters.model);
    }

    const sql = `SELECT * FROM v_usage WHERE ${conditions.join(' AND ')} ORDER BY date ASC, provider ASC, model ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map((r) => RawUsageRowSchema.parse(r));
  }
}
