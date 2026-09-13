// Server-qualified MCP tool identity — fixes a real bug (not just a
// theoretical one): ToolsManager used to key its internal mcpTools Map by
// bare tool name, so two enabled servers exposing an identically-named tool
// silently overwrote each other — the first became completely invisible,
// not merely ambiguous. Every MCP tool now gets two derived identities from
// the same (serverSlug, toolName) pair:
//   - display id  (serverSlug:toolName)  — config.yaml key, table/drawer id,
//     API path param. Human-readable, matches the server's own configured
//     name.
//   - bound name  (serverSlug__toolName) — what's actually bound to the
//     model (RegisteredTool.boundName). Tool-calling APIs (OpenAI,
//     Anthropic) restrict names to [a-zA-Z0-9_-], so the colon form can't
//     be used here.
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §3

/** Lowercase, hyphenate, strip non-alphanumerics — same pattern as
 * api/src/routes/v1/projects.handlers.ts's slugify(), duplicated here since
 * lib/tools-manager has no dependency on api/src. */
export function slugifyServerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function mcpDisplayId(serverSlug: string, toolName: string): string {
  return `${serverSlug}:${toolName}`;
}

export function mcpBoundName(serverSlug: string, toolName: string): string {
  return `${serverSlug}__${toolName}`;
}
