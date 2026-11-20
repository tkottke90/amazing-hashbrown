import { describe, it } from 'mocha';
import { expect } from 'chai';
import { resolveSkillGatedRegistrations } from './skill-tool-gating.js';

describe('agents/skill-tool-gating', () => {
  describe('resolveSkillGatedRegistrations()', () => {
    it('returns no registrations for an empty skill list', () => {
      expect(resolveSkillGatedRegistrations([])).to.deep.equal([]);
    });

    it('skips a skill with no tools field', () => {
      const result = resolveSkillGatedRegistrations([{ name: 'plain-skill' }]);
      expect(result).to.deep.equal([]);
    });

    it('skips a skill with an empty tools string', () => {
      const result = resolveSkillGatedRegistrations([{ name: 'plain-skill', tools: '' }]);
      expect(result).to.deep.equal([]);
    });

    it('skips a skill whose tools string is only whitespace/commas', () => {
      const result = resolveSkillGatedRegistrations([{ name: 'plain-skill', tools: ' , , ' }]);
      expect(result).to.deep.equal([]);
    });

    it('splits a comma-separated tools string, trimming whitespace', () => {
      const result = resolveSkillGatedRegistrations([
        { name: 'create-skill', tools: ' create_app_skill, edit_app_skill ,get_skill_source ' },
      ]);
      expect(result).to.deep.equal([
        {
          skillCommand: 'create-skill',
          toolNames: ['create_app_skill', 'edit_app_skill', 'get_skill_source'],
        },
      ]);
    });

    it('produces one registration per skill, each with its own tool list', () => {
      const result = resolveSkillGatedRegistrations([
        { name: 'create-workspace', tools: 'create_workspace' },
        { name: 'plain-skill' },
        { name: 'create-project', tools: 'create_project' },
      ]);
      expect(result).to.deep.equal([
        { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
        { skillCommand: 'create-project', toolNames: ['create_project'] },
      ]);
    });

    it('passes a mixed built-in + MCP display-id entry through unsplit further — partitioning on ":" is the caller\'s job', () => {
      const result = resolveSkillGatedRegistrations([
        { name: 'n8n-workflow-sync', tools: 'create_workspace,n8n:workflow_search' },
      ]);
      expect(result).to.deep.equal([
        {
          skillCommand: 'n8n-workflow-sync',
          toolNames: ['create_workspace', 'n8n:workflow_search'],
        },
      ]);
    });
  });
});
