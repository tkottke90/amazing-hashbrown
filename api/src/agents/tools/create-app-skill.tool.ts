import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SkillsManager, CreateSkillInput } from '@tkottke90/skills-manager';
import { skillsManager } from '../../services/skills-manager.js';

const MetadataSchema = z.record(z.string(), z.string());

const CreateAppSkillSchema = z.object({
  name: z
    .string()
    .describe(
      'Lowercase, hyphenated skill name (e.g. "wiki-search-tips") — also becomes the slash command.',
    ),
  description: z
    .string()
    .describe(
      'What this skill does and when it should trigger. This is the literal text search_skills ' +
        'and the slash menu match against, so it needs concrete trigger phrases, not a vague summary.',
    ),
  body: z.string().describe('The skill instructions, as Markdown.'),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: MetadataSchema.optional(),
  allowedTools: z.string().optional(),
});

function mapCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('already exists')) {
    return `${message} — use edit_app_skill instead, or pick a different name.`;
  }
  return message;
}

// Factory-injected manager (defaulting to the production singleton) so this
// tool is directly testable against a real, temp-dir-backed SkillsManager —
// matches create-workspace.tool.ts's pattern. Only available while the
// create-skill skill is active (see gated-skill-registrations.ts). Returns
// a plain string on both success and failure, never a Command — see
// chat-agent.ts's buildCreateSkillTools() comment on why these tools never
// close the activeSkill gate themselves.
export function makeCreateAppSkillTool(manager?: SkillsManager) {
  return tool(
    async (input) => {
      const m = manager ?? skillsManager;
      try {
        const skill = await m.create(input as CreateSkillInput);
        return `Created skill "${skill.name}" (app-wide, shows up in the Skill Manager) — available as ${skill.slashCommand}.`;
      } catch (err) {
        return mapCreateError(err);
      }
    },
    {
      name: 'create_app_skill',
      description:
        'Create a new app-wide skill (visible in the Skill Manager and the slash menu for every chat). ' +
        'Only available once the /create-skill skill has been invoked, and only after the draft has been ' +
        'confirmed with the user.',
      schema: CreateAppSkillSchema,
    },
  );
}
