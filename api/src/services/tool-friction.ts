import { ToolFrictionStore } from '@tkottke90/observability';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';

let _store: ToolFrictionStore | null = null;

export function bootToolFriction(db: SqliteDatabase): void {
  _store = new ToolFrictionStore(db);
}

export function getToolFrictionStore(): ToolFrictionStore {
  if (!_store)
    throw new Error('Tool friction store not initialised — call bootToolFriction() first');
  return _store;
}
