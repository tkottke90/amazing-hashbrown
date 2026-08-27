import { mkdtempSync, rmSync } from 'node:fs';
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

const REGISTRATIONS = [
  { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
  { skillCommand: 'create-project', toolNames: ['create_project'] },
];

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
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets activeGatedSkill when a registered gated skill command is expanded', async () => {
    const middleware = createSkillExpansionMiddleware(REGISTRATIONS, manager);
    const result = (await callBeforeAgent(
      middleware,
      makeState('/create-workspace a new one'),
    )) as {
      messages: HumanMessage[];
      activeGatedSkill?: string | null;
    };

    expect(result.activeGatedSkill).to.equal('create-workspace');
    expect(result.messages[0]!.content).to.include('Collect the workspace fields');
    expect(result.messages[0]!.content).to.include('a new one');
  });

  it('clears activeGatedSkill to null for a slash command that is not registered as gated', async () => {
    const middleware = createSkillExpansionMiddleware(REGISTRATIONS, manager);
    const result = (await callBeforeAgent(middleware, makeState('/search-skills foo'))) as {
      activeGatedSkill?: string | null;
    };

    expect(result.activeGatedSkill).to.equal(null);
  });

  it('falls back to a not-found message for an unknown skill, clearing activeGatedSkill to null', async () => {
    const middleware = createSkillExpansionMiddleware(REGISTRATIONS, manager);
    const result = (await callBeforeAgent(middleware, makeState('/does-not-exist'))) as {
      messages: HumanMessage[];
      activeGatedSkill?: string | null;
    };

    expect(result.messages[0]!.content).to.include('not found');
    expect(result.activeGatedSkill).to.equal(null);
  });

  it('returns undefined for a plain (non-slash-command) message', async () => {
    const middleware = createSkillExpansionMiddleware(REGISTRATIONS, manager);
    const result = await callBeforeAgent(middleware, makeState('hello there'));
    expect(result).to.equal(undefined);
  });

  it('reports the correct gate for independent invocations of two different gated skills', async () => {
    const middleware = createSkillExpansionMiddleware(REGISTRATIONS, manager);

    const first = (await callBeforeAgent(middleware, makeState('/create-workspace a new one'))) as {
      activeGatedSkill?: string | null;
    };
    expect(first.activeGatedSkill).to.equal('create-workspace');

    // A second, independent call — proves the middleware itself reports the
    // new gate correctly rather than accidentally carrying over the first
    // call's value. Cross-turn state carryover is LangGraph's job, not this
    // middleware's; that's exercised via the real graph, not this unit test.
    const second = (await callBeforeAgent(middleware, makeState('/create-project a new one'))) as {
      activeGatedSkill?: string | null;
    };
    expect(second.activeGatedSkill).to.equal('create-project');
  });
});
