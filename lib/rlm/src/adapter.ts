// ModelAdapter interface re-exported here so it is importable from "."
// without pulling in any concrete adapter dependencies.
// Concrete implementations live in the "./adapters" sub-path export.
export type { ModelAdapter } from './types.js';
