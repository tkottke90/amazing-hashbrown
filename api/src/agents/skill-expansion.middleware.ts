import { createMiddleware } from 'langchain';
import { HumanMessage } from '@langchain/core/messages';
import type { SkillsManager } from '@tkottke90/skills-manager';
import { skillsManager as defaultSkillsManager } from '../services/skills-manager.js';
import {
  gatedSkillStateSchema,
  type SkillGatedToolRegistration,
} from './skill-gated-tools.middleware.js';

// Expands a slash command in the latest human message immediately before each
// LLM call. Historical messages with slash commands are passed through as-is.
// The checkpoint always stores the original "/command args" — only the messages
// array handed to the LLM is modified (never persisted).
//
// `registrations` is the same list skill-gated-tools.middleware.ts uses —
// when the expanded command matches a registered gated skill, this also sets
// activeGatedSkill so that middleware's wrapModelCall exposes the matching
// tool(s) starting on this same turn.
export function createSkillExpansionMiddleware(
  registrations: SkillGatedToolRegistration[],
  manager: Pick<SkillsManager, 'lookup'> = defaultSkillsManager,
) {
  return createMiddleware({
    name: 'SkillExpansionMiddleware',
    stateSchema: gatedSkillStateSchema,
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

      let expanded: string;
      // Always explicitly resolved on every successful command match (gated
      // skill -> itself, non-gated or unknown command -> null) rather than
      // left unset — an omitted key here would leave a stale gate from an
      // earlier turn untouched. Plain-chat turns never reach this branch at
      // all (see the startsWith('/') check above), which is intentional:
      // mid-flow field collection and post-rejection tool retry both rely
      // on the gate staying open across non-slash-command turns.
      let activeGatedSkill: string | null;
      try {
        const body = await manager.lookup(commandName);
        expanded = args ? `${body}\n\n${args}` : body;
        activeGatedSkill = registrations.some((r) => r.skillCommand === commandName)
          ? commandName
          : null;
      } catch {
        expanded = `[Skill "/${commandName}" not found — use the search_skills tool to see what's available]${args ? '\n\n' + args : ''}`;
        activeGatedSkill = null;
      }

      messages[lastHumanIdx] = new HumanMessage({
        content: expanded,
        id: lastHuman.id,
      });
      return { messages, activeGatedSkill };
    },
  });
}
