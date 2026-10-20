import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createSkillGatedToolsMiddleware } from './skill-gated-tools.middleware.js';
import { GATED_SKILL_REGISTRATIONS } from './gated-skill-registrations.js';

function fakeTool(name: string) {
  return { name } as unknown as { name: string };
}

const ALWAYS_ON = [fakeTool('ask_user'), fakeTool('wiki_search')];
const GATED = [fakeTool('create_workspace'), fakeTool('create_project')];

function fakeRequest(activeSkill: string | null) {
  return {
    tools: [...ALWAYS_ON, ...GATED],
    state: { activeSkill },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('agents/skill-gated-tools.middleware', () => {
  const registrations = [
    { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
    { skillCommand: 'create-project', toolNames: ['create_project'] },
  ];

  it('hides gated tools from the model when no skill is active', async () => {
    const middleware = createSkillGatedToolsMiddleware(registrations);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest(null), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search']);
  });

  it("exposes only the matching skill's tools when that skill is active", async () => {
    const middleware = createSkillGatedToolsMiddleware(registrations);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest('create-workspace'), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal([
      'ask_user',
      'wiki_search',
      'create_workspace',
    ]);
  });

  it('does not expose a gated tool for an unregistered activeSkill value', async () => {
    const middleware = createSkillGatedToolsMiddleware(registrations);
    let seenTools: { name: string }[] = [];
    const handler = async (req: { tools: { name: string }[] }) => {
      seenTools = req.tools;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return {} as any;
    };

    await middleware.wrapModelCall!(fakeRequest('some-unrelated-skill'), handler);

    expect(seenTools.map((t) => t.name)).to.deep.equal(['ask_user', 'wiki_search']);
  });

  // Exercises the real, production registration array (rather than this
  // file's own minimal fixture above) so a future edit to
  // gated-skill-registrations.ts that drops or misnames the
  // resolve-file-conflict entry fails here, not only in manual testing.
  describe('propose_file_merge (resolve-file-conflict registration)', () => {
    const tools = [...ALWAYS_ON, ...GATED, fakeTool('propose_file_merge')];

    function requestWith(activeSkill: string | null) {
      return {
        tools,
        state: { activeSkill },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    it('is hidden when resolve-file-conflict is not the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith(null), handler);

      expect(seenTools.map((t) => t.name)).to.not.include('propose_file_merge');
    });

    it('is exposed once resolve-file-conflict is the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith('resolve-file-conflict'), handler);

      expect(seenTools.map((t) => t.name)).to.include('propose_file_merge');
    });
  });

  // Same reasoning as the resolve-file-conflict block above, for
  // create-skill's nine tools — fails here if a future edit to
  // gated-skill-registrations.ts drops or misnames any of them.
  describe('create-skill tools (create-skill registration)', () => {
    const CREATE_SKILL_TOOL_NAMES = [
      'create_app_skill',
      'edit_app_skill',
      'create_workspace_skill',
      'edit_workspace_skill',
      'get_skill_source',
      'create_skill_artifact',
      'update_skill_artifact',
      'delete_skill_artifact',
      'test_skill_artifact',
    ];
    const tools = [...ALWAYS_ON, ...GATED, ...CREATE_SKILL_TOOL_NAMES.map(fakeTool)];

    function requestWith(activeSkill: string | null) {
      return {
        tools,
        state: { activeSkill },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    it('hides all nine tools when create-skill is not the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith(null), handler);

      for (const name of CREATE_SKILL_TOOL_NAMES) {
        expect(seenTools.map((t) => t.name)).to.not.include(name);
      }
    });

    it('exposes all nine tools together once create-skill is the active gated skill', async () => {
      const middleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);
      let seenTools: { name: string }[] = [];
      const handler = async (req: { tools: { name: string }[] }) => {
        seenTools = req.tools;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return {} as any;
      };

      await middleware.wrapModelCall!(requestWith('create-skill'), handler);

      for (const name of CREATE_SKILL_TOOL_NAMES) {
        expect(seenTools.map((t) => t.name)).to.include(name);
      }
    });
  });
});
