import type { SkillsManager } from '@tkottke90/skills-manager';
import { buildArtifactIndex } from './artifact-index.js';

export type SkillExpansion = { ok: true; text: string } | { ok: false };

// The one place a skill's body is turned into the text the model sees: the
// authored body, then any caller-supplied args, then the Artifact Index
// (ADR-0022). Shared by the slash-command middleware
// (skill-expansion.middleware.ts) and the use_skill tool so a self-invoked
// skill reads exactly like a typed one. Failure to load (unknown name, a
// skill broken enough to have failed boot) is reported as `ok: false` rather
// than thrown — callers word their own not-found message.
export async function expandSkill(
  manager: Pick<SkillsManager, 'load'>,
  name: string,
  args = '',
): Promise<SkillExpansion> {
  try {
    const skill = await manager.load(name);
    let text = args ? `${skill.body}\n\n${args}` : skill.body;
    const index = buildArtifactIndex(skill.scripts, skill.references);
    if (index) text = `${text}\n\n${index}`;
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}
