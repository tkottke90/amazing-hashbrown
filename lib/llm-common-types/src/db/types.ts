// Pagination options accepted by all list/query methods across the application's data stores.
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

// Every record stored in the shared SQLite database carries at least a creation timestamp.
// Specific record types extend this shape as needed.
export interface BaseRecord {
  createdAt: string; // ISO 8601
}

// IReadDao — the read side of any single-record-type store.
//
// TRecord:  the full record shape returned from the database.
// TFilters: query filters accepted by find(); must extend PaginationOptions.
//
// All data stores in this application implement this interface for their primary record type.
// The Task System, Persistent Memory, and Observability stores are examples.
// Note: TRecord does not require BaseRecord because some stores (e.g. ObservabilityStore) use
// a domain-specific timestamp field (startedAt) rather than the generic createdAt convention.
export interface IReadDao<
  TRecord extends object,
  TFilters extends PaginationOptions = PaginationOptions,
> {
  findById(id: string): TRecord | null;
  find(filters?: TFilters): TRecord[];
}

// IWriteDao — the write side of any store.
//
// TCreateInput: the fields required to create a new record.
//               Typically omits auto-generated fields (id, createdAt, etc.).
export interface IWriteDao<TCreateInput, TRecord extends BaseRecord> {
  create(input: TCreateInput): TRecord;
  update(id: string, input: Partial<TCreateInput>): TRecord | null;
  delete(id: string): boolean;
}

// DbMigration — a single versioned DDL statement.
//
// Each store registers its own migrations. The shared database runner applies them in
// ascending version order at startup, skipping any version already applied.
//
// version: a monotonically increasing integer that is unique across ALL features sharing
//          the database — not just within a single store. Co-ordinate version numbers
//          when adding a new store so they don't collide with existing ones.
// sql:     one or more SQL statements (CREATE TABLE IF NOT EXISTS, CREATE INDEX, etc.)
//          separated by semicolons.
export interface DbMigration {
  version: number;
  sql: string;
}
