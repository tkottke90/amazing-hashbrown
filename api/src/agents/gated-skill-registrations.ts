import type { SkillGatedToolRegistration } from './skill-gated-tools.middleware.js';

// Skill-Gated Tools registrations — the single source of truth
// skillGatedToolsMiddleware (filters the model's tool list by exact skill
// name match against activeSkill) reads from. skillExpansionMiddleware sets
// activeSkill for every resolved skill now (ADR-0019), not just these.
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
  { skillCommand: 'resolve-file-conflict', toolNames: ['propose_file_merge'] },
  {
    skillCommand: 'create-skill',
    toolNames: [
      'create_app_skill',
      'edit_app_skill',
      'create_workspace_skill',
      'edit_workspace_skill',
      'get_skill_source',
      'create_skill_artifact',
      'update_skill_artifact',
      'delete_skill_artifact',
      'test_skill_artifact',
    ],
  },
];
