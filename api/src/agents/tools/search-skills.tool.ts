import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { skillsManager } from '../../services/skills-manager.js';

const SearchSkillsInputSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe(
      'Optional search term. Matches skill name, description, or slash command (case-insensitive substring). Omit to list all available skills.',
    ),
});

export const searchSkillsTool = tool(
  async ({ keyword }) => {
    const results = skillsManager.search(keyword);
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
