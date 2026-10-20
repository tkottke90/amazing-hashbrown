import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { HumanMessage } from '@langchain/core/messages';
import { SkillsManager } from '@tkottke90/skills-manager';
import { createSkillExpansionMiddleware } from './skill-expansion.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeState(content: string): { messages: any[] } {
  return { messages: [new HumanMessage(content)] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callBeforeAgent(middleware: any, state: { messages: any[] }): Promise<unknown> {
  return middleware.beforeAgent(state);
}

// Only used for the workspace-child `reserved` list below — the middleware
// itself no longer takes a registrations argument (activeSkill is set for
// every resolved skill, gated or not — ADR-0019).
const GATED_SKILL_NAMES = ['create-workspace', 'create-project'];

describe('agents/skill-expansion.middleware', () => {
  let manager: SkillsManager;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-expansion-test-'));
    manager = new SkillsManager(dir);
    await manager.boot();
    await manager.create({
      name: 'create-workspace',
      description: 'Create a workspace conversationally.',
      body: 'Collect the workspace fields, then call create_workspace.',
    });
    await manager.create({
      name: 'create-project',
      description: 'Create a project conversationally.',
      body: 'Collect the project fields, then call create_project.',
    });
    await manager.create({
      name: 'search-skills',
      description: 'Not a gated skill.',
      body: 'Just some other skill body.',
    });
    await manager.create({
      name: 'with-artifacts',
      description: 'Has real scripts/references on disk.',
      body: 'Use the artifacts below.',
    });
    await manager.writeFile('with-artifacts', 'scripts', 'check.sh', 'echo hi');
    await manager.writeFile('with-artifacts', 'references', 'operations.md', '# Ops');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets activeSkill when a registered gated skill command is expanded', async () => {
    const middleware = createSkillExpansionMiddleware(async () => manager);
    const result = (await callBeforeAgent(
      middleware,
      makeState('/create-workspace a new one'),
    )) as {
      messages: HumanMessage[];
      activeSkill?: string | null;
    };

    expect(result.activeSkill).to.equal('create-workspace');
    expect(result.messages[0]!.content).to.include('Collect the workspace fields');
    expect(result.messages[0]!.content).to.include('a new one');
  });

  it('sets activeSkill even for a resolved skill with no gated registration', async () => {
    const middleware = createSkillExpansionMiddleware(async () => manager);
    const result = (await callBeforeAgent(middleware, makeState('/search-skills foo'))) as {
      activeSkill?: string | null;
    };

    expect(result.activeSkill).to.equal('search-skills');
  });

  it('falls back to a not-found message for an unknown skill, clearing activeSkill to null', async () => {
    const middleware = createSkillExpansionMiddleware(async () => manager);
    const result = (await callBeforeAgent(middleware, makeState('/does-not-exist'))) as {
      messages: HumanMessage[];
      activeSkill?: string | null;
    };

    expect(result.messages[0]!.content).to.include('not found');
    expect(result.activeSkill).to.equal(null);
  });

  it('returns undefined for a plain (non-slash-command) message', async () => {
    const middleware = createSkillExpansionMiddleware(async () => manager);
    const result = await callBeforeAgent(middleware, makeState('hello there'));
    expect(result).to.equal(undefined);
  });

  it('reports the correct active skill for independent invocations of two different skills', async () => {
    const middleware = createSkillExpansionMiddleware(async () => manager);

    const first = (await callBeforeAgent(middleware, makeState('/create-workspace a new one'))) as {
      activeSkill?: string | null;
    };
    expect(first.activeSkill).to.equal('create-workspace');

    // A second, independent call — proves the middleware itself reports the
    // new value correctly rather than accidentally carrying over the first
    // call's value. Cross-turn state carryover is LangGraph's job, not this
    // middleware's; that's exercised via the real graph, not this unit test.
    const second = (await callBeforeAgent(middleware, makeState('/create-project a new one'))) as {
      activeSkill?: string | null;
    };
    expect(second.activeSkill).to.equal('create-project');
  });

  describe('Artifact Index', () => {
    it('appends the Available Artifacts section for a skill with scripts/references', async () => {
      const middleware = createSkillExpansionMiddleware(async () => manager);
      const result = (await callBeforeAgent(middleware, makeState('/with-artifacts'))) as {
        messages: HumanMessage[];
      };

      const content = result.messages[0]!.content as string;
      expect(content).to.include('Use the artifacts below.');
      expect(content).to.include('## Available Artifacts');
      expect(content).to.include('Reference `operations.md`');
      expect(content).to.include('Script `check.sh`');
    });

    it('omits the Available Artifacts section for a skill with neither', async () => {
      const middleware = createSkillExpansionMiddleware(async () => manager);
      const result = (await callBeforeAgent(middleware, makeState('/search-skills'))) as {
        messages: HumanMessage[];
      };

      expect(result.messages[0]!.content as string).to.not.include('Available Artifacts');
    });
  });

  // Workspace chat passes a child manager layered over the global one (see
  // services/workspace-skills.ts). These pin that expansion honors it —
  // including that a repo can never take over a gated skill's instructions.
  describe('with a workspace child manager', () => {
    let repoRoot: string;

    before(() => {
      repoRoot = join(dir, 'repo-skills');
      for (const [name, body] of [
        ['repo-deploy', 'Repo deploy instructions.'],
        ['create-project', 'Repo hijack instructions.'],
      ]) {
        mkdirSync(join(repoRoot, name), { recursive: true });
        writeFileSync(
          join(repoRoot, name, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
        );
      }
    });

    async function bootChild(): Promise<SkillsManager> {
      const child = manager.createChild(repoRoot, {
        source: 'repo',
        reserved: GATED_SKILL_NAMES,
      });
      await child.boot();
      return child;
    }

    it('expands a repo-provided skill body [unit]', async () => {
      const child = await bootChild();
      const middleware = createSkillExpansionMiddleware(async () => child);
      const result = (await callBeforeAgent(middleware, makeState('/repo-deploy prod'))) as {
        messages: HumanMessage[];
        activeSkill?: string | null;
      };
      expect(result.messages[0]!.content).to.equal('Repo deploy instructions.\n\n\nprod');
      expect(result.activeSkill).to.equal('repo-deploy');
    });

    it('still expands the global body for a gated name the repo also ships [unit]', async () => {
      const child = await bootChild();
      const middleware = createSkillExpansionMiddleware(async () => child);
      const result = (await callBeforeAgent(middleware, makeState('/create-project x'))) as {
        messages: HumanMessage[];
        activeSkill?: string | null;
      };
      expect(result.messages[0]!.content).to.include('then call create_project');
      expect(result.messages[0]!.content).to.not.include('hijack');
      expect(result.activeSkill).to.equal('create-project');
    });

    // Resolving a workspace's skills reads the disk; ordinary chat turns must
    // not pay for it.
    it('does not resolve skills for a non-slash message [unit]', async () => {
      let calls = 0;
      const middleware = createSkillExpansionMiddleware(async () => {
        calls++;
        return manager;
      });
      await callBeforeAgent(middleware, makeState('just chatting'));
      expect(calls).to.equal(0);
    });
  });
});
