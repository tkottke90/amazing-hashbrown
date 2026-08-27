import type { SkillGatedToolRegistration } from './skill-gated-tools.middleware.js';

// Skill-Gated Tools registrations — the single source of truth both
// skillExpansionMiddleware (sets activeGatedSkill) and
// skillGatedToolsMiddleware (filters the model's tool list by it) read from.
// See AGENTS.md § Composition over Customization: a future chat-invoked tool
// that should only be visible after its skill is typed adds an entry here
// rather than writing new middleware.
//
// Lives in its own file (rather than inline in chat-agent.ts, where it used
// to be) so bin/eval.ts can import it directly without pulling in
// chat-agent.ts's much heavier import graph (tools-manager, provider-factory,
// etc.) just to read this two-item array — see
// docs/superpowers/specs/2026-08-27-skill-gated-tools-hardening-design.md.
export const GATED_SKILL_REGISTRATIONS: SkillGatedToolRegistration[] = [
  { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
  { skillCommand: 'create-project', toolNames: ['create_project'] },
];
