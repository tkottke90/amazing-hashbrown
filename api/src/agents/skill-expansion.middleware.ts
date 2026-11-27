import { createMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager as defaultSkillsManager } from '../services/skills-manager.js';
import { activeSkillStateSchema } from './skill-gated-tools.middleware.js';
import { expandSkill, type SkillExpansion } from './skill-expansion.js';

// Expands a slash command in the latest human message immediately before each
// LLM call. Historical messages with slash commands are passed through as-is.
// The checkpoint always stores the original "/command args" — only the messages
// array handed to the LLM is modified (never persisted).
//
// activeSkill is set for every resolved skill invocation, not just the
// handful with a Skill-Gated Tools registration (ADR-0019) — it's the one
// state channel skill-gated-tools.middleware.ts (exact-name gating) and
// skill-scoped-tools.middleware.ts (any-skill-is-active gating) both read.
// See GLOSSARY.md § Skill Invocation & Runtime Access.
//
// `getSkills` resolves the skill source per invocation rather than taking a
// fixed manager, so workspace agents can serve that workspace's
// .agents/skills (see services/workspace-skills.ts) and pick up edits
// without rebuilding the agent. It's only called for slash commands, so
// ordinary chat turns never touch the disk.
export function createSkillExpansionMiddleware(
  getSkills: () => Promise<Pick<SkillsManager, 'load'>> = async () => defaultSkillsManager,
) {
  return createMiddleware({
    name: 'SkillExpansionMiddleware',
    stateSchema: activeSkillStateSchema,
    beforeAgent: async (state) => {
      const messages = [...state.messages];
      let lastHumanIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.getType() === 'human') {
          lastHumanIdx = i;
          break;
        }
      }
      if (lastHumanIdx === -1) return undefined;
      const lastHuman = messages[lastHumanIdx];
      if (!lastHuman) return undefined;
      const content = lastHuman.content;
      if (typeof content !== 'string' || !content.startsWith('/')) return undefined;

      const spaceIdx = content.indexOf(' ');
      const commandName = spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1);

      // Always explicitly resolved on every successful or failed command
      // match rather than left unset — an omitted key here would leave a
      // stale value from an earlier turn untouched. Plain-chat turns never
      // reach this branch at all (see the startsWith('/') check above),
      // which is intentional: mid-flow field collection and post-rejection
      // tool retry both rely on the value staying put across non-slash-
      // command turns.
      let expanded: string;
      let activeSkill: string | null;
      let expansion: SkillExpansion;
      try {
        expansion = await expandSkill(await getSkills(), commandName, args);
      } catch {
        expansion = { ok: false };
      }
      if (expansion.ok) {
        expanded = expansion.text;
        activeSkill = commandName;
      } else {
        expanded = `[Skill "/${commandName}" not found — use the search_skills tool to see what's available]${args ? '\n\n' + args : ''}`;
        activeSkill = null;
      }

      messages[lastHumanIdx] = new HumanMessage({
        content: expanded,
        id: lastHuman.id,
      });
      return { messages, activeSkill };
    },
  });
}
