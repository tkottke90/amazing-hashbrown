import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager } from '../../services/skills-manager.js';
import { expandSkill } from '../skill-expansion.js';
import type { activeSkillStateSchema } from '../skill-gated-tools.middleware.js';

const UseSkillInputSchema = z.object({
  name: z
    .string()
    .describe(
      'The skill to load — its name as returned by search_skills, or as named in the task or request, without a leading slash.',
    ),
});

// Model-initiated equivalent of typing "/name": loads the skill's body and
// Artifact Index (via the same expandSkill() the slash-command middleware
// uses) and makes it the Active Skill, so its `tools:`-gated tools and the
// Skill-Scoped Tools bind from the next model call on. Needed because
// non-interactive runs (tasks, sub-agents) have no human turn to type a
// slash command into.
//
// Resolves the skill source on every call, like makeSearchSkillsTool, so a
// workspace agent sees that workspace's current .agents/skills alongside the
// global ones — and a name resolves exactly as /name would for the same
// agent. An unknown name returns plain text and leaves activeSkill alone.
// Active Skill is single-valued (ADR-0019): invoking a second skill replaces
// the first, which the result says outright so the model knows the earlier
// skill's tools are gone.
export function makeUseSkillTool(getSkills: () => Promise<Pick<SkillsManager, 'load'>>) {
  return tool(
    async (
      { name }: z.infer<typeof UseSkillInputSchema>,
      runtime: ToolRuntime<typeof activeSkillStateSchema>,
    ) => {
      const skillName = name.replace(/^\//, '').trim();
      const expansion = await expandSkill(await getSkills(), skillName);
      if (!expansion.ok) {
        return `Skill "${skillName}" not found — use the search_skills tool to see what's available.`;
      }

      const previous = runtime.state?.activeSkill ?? null;
      const replaced =
        previous && previous !== skillName
          ? `Replaced active skill "${previous}" with "${skillName}" — the tools "${previous}" unlocked are no longer available.\n\n`
          : '';

      return new Command({
        update: {
          activeSkill: skillName,
          messages: [
            new ToolMessage({
              content: `${replaced}${expansion.text}`,
              tool_call_id: runtime.toolCallId,
              name: 'use_skill',
            }),
          ],
        },
      });
    },
    {
      name: 'use_skill',
      description:
        "Load a skill's full instructions and make it the active skill — the same as the user typing " +
        '/skill-name. Call it after finding a skill with search_skills, or directly when the request or ' +
        'task names one. Loading a skill also unlocks any tools it declares. Only one skill is active at a ' +
        'time: loading another replaces the first.',
      schema: UseSkillInputSchema,
    },
  );
}

// Global-only instance for callers with no workspace (plain chat, bin/eval.ts).
export const useSkillTool = makeUseSkillTool(async () => skillsManager);
