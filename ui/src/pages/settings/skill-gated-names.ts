// Mirrors api/src/agents/gated-skill-registrations.ts's skill names, purely
// for client-side UX (disabling the Delete button, warning before disable).
// The backend's 409 on DELETE is the actual, authoritative guard — this is
// intentional small duplication of two strings, not worth a shared package.
export const GATED_SKILL_NAMES: readonly string[] = ['create-workspace', 'create-project'];

export const GATED_TOOL_BY_SKILL: Record<string, string> = {
  'create-workspace': 'create_workspace',
  'create-project': 'create_project',
};
