import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager as defaultSkillsManager } from '../../services/skills-manager.js';
import { GATED_SKILL_REGISTRATIONS } from '../gated-skill-registrations.js';

const ActivateSkillSchema = z.object({
  name: z.string().describe('The skill command to activate, e.g. "file-ops".'),
});

// A plain string, not a z.enum — an enum could fail schema validation before
// this tool's handler ever runs on some backends, which would mean the
// handler never gets a chance to return the corrective "here's what's
// valid" message below. A string guarantees the handler always runs and
// always controls the error text.

// Only skills that are BOTH registered as tool-gated (GATED_SKILL_REGISTRATIONS)
// AND explicitly opted into self-callable (metadata.selfCallable === 'true')
// are valid activation targets — being gated alone isn't enough, since
// self-callable is a deliberate per-skill choice (by the application for its
// own built-in skills, or by a user on their own custom skill), not a
// default every gated skill gets.
async function listSelfCallableNames(manager: Pick<SkillsManager, 'load'>): Promise<string[]> {
  const names: string[] = [];
  for (const registration of GATED_SKILL_REGISTRATIONS) {
    try {
      const skill = await manager.load(registration.skillCommand);
      if (skill.frontmatter.metadata?.['selfCallable'] === 'true') {
        names.push(registration.skillCommand);
      }
    } catch {
      // Skill was removed/never installed — just not a valid target.
    }
  }
  return names;
}

async function notFoundMessage(
  name: string,
  manager: Pick<SkillsManager, 'load'>,
): Promise<string> {
  const valid = await listSelfCallableNames(manager);
  return valid.length > 0
    ? `"${name}" is not a self-callable skill. Available self-callable skills: ${valid.join(', ')}.`
    : `"${name}" is not a self-callable skill, and no skills are currently self-callable.`;
}

// One generic gateway tool for every self-callable skill, rather than a
// bespoke "activate_x" tool per skill — the Skill-Gated Tools pattern's own
// composition principle (see AGENTS.md § Composition over Customization).
export function makeActivateSkillTool(manager: Pick<SkillsManager, 'load'> = defaultSkillsManager) {
  return tool(
    async ({ name }: { name: string }, runtime: ToolRuntime) => {
      const registration = GATED_SKILL_REGISTRATIONS.find((r) => r.skillCommand === name);
      if (!registration) return notFoundMessage(name, manager);

      let skill;
      try {
        skill = await manager.load(name);
      } catch {
        return notFoundMessage(name, manager);
      }

      if (skill.frontmatter.metadata?.['selfCallable'] !== 'true') {
        return notFoundMessage(name, manager);
      }

      // Mirrors create-workspace.tool.ts's existing Command usage exactly —
      // that tool CLOSES a gate on success; this one OPENS one. Because this
      // is a tool result (not a plain-text final answer), the ReAct loop
      // continues into a model call that already sees the newly gated tools
      // via skillGatedToolsMiddleware — no new graph-control-flow needed.
      return new Command({
        update: {
          activeGatedSkill: name,
          messages: [
            new ToolMessage({
              content: skill.body,
              tool_call_id: runtime.toolCallId,
              name: 'activate_skill',
            }),
          ],
        },
      });
    },
    {
      name: 'activate_skill',
      description:
        'Self-activate a skill that is marked self-callable, unlocking the tools it gates. ' +
        'Use search_skills first if you are not sure of the exact skill name.',
      schema: ActivateSkillSchema,
    },
  );
}

export const activateSkillTool = makeActivateSkillTool();
