import type { SkillSummary } from '@tkottke90/skills-manager';
import type { SkillGatedToolRegistration } from './skill-gated-tools.middleware.js';

// Converts a live skill list into Skill-Gated Tools registrations — the
// replacement for the old hardcoded GATED_SKILL_REGISTRATIONS array (issue
// #409). Each skill declares its own gated tool names in its SKILL.md
// frontmatter `tools` field (comma-separated, built-in names and MCP
// display ids like "n8n:workflow_search" mixed together — see GLOSSARY.md §
// Skill Invocation & Runtime Access, Skill Tools Field); this function does
// nothing but turn that raw string into the same SkillGatedToolRegistration
// shape the middleware already consumed. Deliberately touches nothing else
// — no TOOL_CATALOG, no live MCP catalog, no tool-config.ts — so callers
// that only need "which skills declared which tool names" (bin/eval.ts
// included) stay free of this app's heavier import graph, the same
// rationale gated-skill-registrations.ts's own header comment gave for why
// it lived in its own file.
export function resolveSkillGatedRegistrations(
  skills: Pick<SkillSummary, 'name' | 'tools'>[],
): SkillGatedToolRegistration[] {
  const registrations: SkillGatedToolRegistration[] = [];

  for (const skill of skills) {
    const toolNames = (skill.tools ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    if (toolNames.length === 0) continue;
    registrations.push({ skillCommand: skill.name, toolNames });
  }

  return registrations;
}
