import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SkillsManager, EditSkillInput } from '@tkottke90/skills-manager';
import { skillsManager } from '../../services/skills-manager.js';

const MetadataSchema = z.record(z.string(), z.string());

const EditAppSkillSchema = z.object({
  name: z.string().describe('The existing app-wide skill to edit.'),
  description: z.string().optional(),
  body: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
});

// Same factory/testability pattern as create-app-skill.tool.ts. Only
// available while the create-skill skill is active.
export function makeEditAppSkillTool(manager?: SkillsManager) {
  return tool(
    async ({ name, ...changes }) => {
      const m = manager ?? skillsManager;
      try {
        const skill = await m.edit(name, changes as EditSkillInput);
        return `Updated skill "${skill.name}" (app-wide).`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) {
          return `${message} — use get_skill_source to confirm the exact name and scope first.`;
        }
        return message;
      }
    },
    {
      name: 'edit_app_skill',
      description:
        'Edit an existing app-wide skill (fields given replace the current value; anything omitted is ' +
        'left unchanged). Only available once the /create-skill skill has been invoked, and only after the ' +
        'draft has been confirmed with the user.',
      schema: EditAppSkillSchema,
    },
  );
}
