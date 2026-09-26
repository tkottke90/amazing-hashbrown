import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager } from '../../services/skills-manager.js';

const SearchSkillsInputSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe(
      'Optional search term. Matches skill name, description, or slash command (case-insensitive substring). Omit to list all available skills.',
    ),
});

// Resolves the skill source on every call (not once at build time) so a
// workspace agent searches that workspace's current .agents/skills alongside
// the global skills. Output shape is identical whatever the source.
export function makeSearchSkillsTool(getSkills: () => Promise<Pick<SkillsManager, 'search'>>) {
  return tool(
    async ({ keyword }) => {
      const results = (await getSkills()).search(keyword);
      if (results.length === 0) {
        return keyword ? `No skills found matching "${keyword}".` : 'No skills are installed.';
      }
      return JSON.stringify(
        results.map((s) => ({
          name: s.name,
          slashCommand: s.slashCommand,
          description: s.description,
        })),
      );
    },
    {
      name: 'search_skills',
      description:
        'Search available skills by keyword. Returns skill names, slash commands, and descriptions. Call with no argument to list all skills.',
      schema: SearchSkillsInputSchema,
    },
  );
}

// Global-only instance for callers with no workspace (plain chat, bin/eval.ts).
export const searchSkillsTool = makeSearchSkillsTool(async () => skillsManager);
