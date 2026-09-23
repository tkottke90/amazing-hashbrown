import { z } from 'zod';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';

const RawFrictionRowSchema = z
  .object({
    tool_name: z.string(),
    date: z.string(),
    call_count: z.number(),
    error_count: z.number(),
  })
  .transform((row) => ({
    toolName: row.tool_name,
    date: row.date,
    callCount: row.call_count,
    errorCount: row.error_count,
  }));

export type ToolFrictionRow = z.output<typeof RawFrictionRowSchema>;

export interface ToolFrictionFilters {
  from: string;
  to: string;
  toolName?: string;
}

// Friction and cost are different concerns that happen to share the same
// underlying observability_spans table — kept as its own store rather than
// folded into CostStore, same separation CostStore itself keeps from the
// base ObservabilityStore.
//
// Version numbers must be unique across ALL features sharing this database
// (see BaseStore's migration doc) — 31 was the next free number as of this
// migration (ObservabilityStore: 1,5,7,9; CostStore: 2; EvaluationsStore: 3,6,8;
// thread-store: 4,10-16,29; tool-settings-store: 28,30; workspace-store:
// 18-27; shell-audit: 17,32).
const MIGRATIONS: DbMigration[] = [
  {
    version: 31,
    sql: `
      CREATE VIEW IF NOT EXISTS v_tool_friction AS
      SELECT
        s.name AS tool_name,
        date(s.started_at) AS date,
        COUNT(*) AS call_count,
        SUM(CASE WHEN s.error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
      FROM observability_spans s
      WHERE s.type = 'tool-call'
      GROUP BY s.name, date(s.started_at);
    `,
  },
];

export class ToolFrictionStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  // Requires no new capture logic — every tool-call span already has
  // name/error recorded automatically by ObservabilityCallbackHandler the
  // moment a tool is bound to the agent.
  queryFriction(filters: ToolFrictionFilters): ToolFrictionRow[] {
    const conditions = ['date >= ?', 'date <= ?'];
    const values: unknown[] = [filters.from, filters.to];

    if (filters.toolName) {
      conditions.push('tool_name = ?');
      values.push(filters.toolName);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM v_tool_friction WHERE ${conditions.join(' AND ')} ORDER BY date ASC, tool_name ASC`,
      )
      .all(values);

    return rows.map((row) => RawFrictionRowSchema.parse(row));
  }
}
