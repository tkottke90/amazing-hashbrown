import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { bootObservability, getObservabilityStore } from '../services/observability.js';
import type { Workspace } from '../services/workspace-store.js';
import type { FileNode } from '../services/workspace-files.js';
import {
  buildFileListingBlock,
  buildPathAPrompt,
  buildTaskDescriptionBlock,
  buildWikiContextBlock,
  parsePlanSteps,
  runPathA,
  runPathB,
} from './plan-generation.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

// Answers directly with a final JSON array on the first (human) turn — no
// tool call — since the real wiki_search/wiki_read_page tools baked into
// runPathB reach this process's actual singleton wiki registry (getWikiRegistry()
// in ../services/wiki.js has no test seam), which a unit test must not touch
// (would create real files on disk as a side effect). This still proves
// runPathB's real createAgent() graph (no checkpointer) completes an invoke()
// and that the final-message extraction picks up the right text, without a
// live LLM. The tool-calling loop itself is exercised elsewhere in this repo's
// test suite (thread-fork.test.ts) against a dummy tool with no such seam gap.
class ScriptedChatModel extends BaseChatModel {
  _llmType() {
    return 'scripted-fake';
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const text = '[{"step": "Look into it", "done": false}]';
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}

const sampleWorkspace: Workspace = {
  id: 'ws-1',
  name: 'Widget Factory',
  description: 'Builds widgets',
  goal: 'Ship v2 of the widget pipeline',
  location: '/tmp/widget-factory',
  remoteUrl: null,
  javascript: true,
  python: false,
  git: true,
  wikiId: 'widget-wiki',
  systemPrompt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastChange: '2026-01-01T00:00:00.000Z',
};

describe('agents/plan-generation', () => {
  describe('parsePlanSteps()', () => {
    it('parses a valid JSON array', () => {
      const steps = parsePlanSteps('[{"step": "Do the thing", "done": false}]');
      expect(steps).to.deep.equal([{ step: 'Do the thing', done: false }]);
    });

    it('strips a ```json fenced response', () => {
      const steps = parsePlanSteps('```json\n[{"step": "Do it", "done": false}]\n```');
      expect(steps).to.deep.equal([{ step: 'Do it', done: false }]);
    });

    it('accepts an empty array', () => {
      expect(parsePlanSteps('[]')).to.deep.equal([]);
    });

    it('returns null for non-JSON text', () => {
      expect(parsePlanSteps('sure, here is a plan: first do X')).to.equal(null);
    });

    it('returns null for a JSON object instead of an array', () => {
      expect(parsePlanSteps('{"step": "Do it", "done": false}')).to.equal(null);
    });

    it('returns null when a step is missing the done key', () => {
      expect(parsePlanSteps('[{"step": "Do it"}]')).to.equal(null);
    });

    it('returns null when step is not a string', () => {
      expect(parsePlanSteps('[{"step": 5, "done": false}]')).to.equal(null);
    });
  });

  describe('buildTaskDescriptionBlock()', () => {
    it('omits the Description line when null', () => {
      expect(buildTaskDescriptionBlock('Ship it', null)).to.equal('Title: Ship it');
    });

    it('includes both lines when description is present', () => {
      expect(buildTaskDescriptionBlock('Ship it', 'Get v2 out the door')).to.equal(
        'Title: Ship it\nDescription: Get v2 out the door',
      );
    });
  });

  describe('buildPathAPrompt()', () => {
    it('omits workspace/wiki/file sections when all are null', () => {
      const prompt = buildPathAPrompt({
        title: 'Ship it',
        description: null,
        workspace: null,
        wikiBlock: null,
        fileBlock: null,
      });
      expect(prompt).to.not.include('## Workspace');
      expect(prompt).to.not.include('## Relevant wiki context');
      expect(prompt).to.not.include('## Workspace files');
      expect(prompt).to.include('Title: Ship it');
      expect(prompt).to.include('Respond with ONLY a JSON array');
    });

    it('includes the workspace section when workspace is present', () => {
      const prompt = buildPathAPrompt({
        title: 'Ship it',
        description: null,
        workspace: sampleWorkspace,
        wikiBlock: null,
        fileBlock: null,
      });
      expect(prompt).to.include('## Workspace');
      expect(prompt).to.include('Name: Widget Factory');
      expect(prompt).to.include('Goal: Ship v2 of the widget pipeline');
    });

    it('includes wiki and file-listing sections when present', () => {
      const prompt = buildPathAPrompt({
        title: 'Ship it',
        description: null,
        workspace: sampleWorkspace,
        wikiBlock: '### Deploy runbook\nRun the deploy script.',
        fileBlock: '- src/ (dir)\n- README.md (file)',
      });
      expect(prompt).to.include('## Relevant wiki context');
      expect(prompt).to.include('Deploy runbook');
      expect(prompt).to.include('## Workspace files (top level)');
      expect(prompt).to.include('- src/ (dir)');
    });
  });

  describe('buildWikiContextBlock()', () => {
    it('returns null when wiki is null', async () => {
      expect(await buildWikiContextBlock(null, 'query')).to.equal(null);
    });

    it('returns null when search returns no results', async () => {
      const wiki = {
        semanticSearch: async () => [],
        readPage: async () => {
          throw new Error('should not be called');
        },
      };
      expect(await buildWikiContextBlock(wiki, 'query')).to.equal(null);
    });

    it('returns null when search itself throws', async () => {
      const wiki = {
        semanticSearch: async () => {
          throw new Error('search failed');
        },
        readPage: async () => {
          throw new Error('should not be called');
        },
      };
      expect(await buildWikiContextBlock(wiki, 'query')).to.equal(null);
    });

    it('formats readPage results, skipping a page that fails to read', async () => {
      const wiki = {
        semanticSearch: async () => [
          { path: 'a.md', score: 0.9, title: 'A' },
          { path: 'b.md', score: 0.5, title: 'B' },
        ],
        readPage: async (path: string) => {
          if (path === 'b.md') throw new Error('gone');
          return { title: 'A', frontmatter: { type: 'note', tags: [] }, content: 'Content of A' };
        },
      };
      const block = await buildWikiContextBlock(wiki, 'query');
      expect(block).to.include('### A');
      expect(block).to.include('Content of A');
      expect(block).to.not.include('### B');
    });
  });

  describe('buildFileListingBlock()', () => {
    it('returns null for null/empty entries', () => {
      expect(buildFileListingBlock(null)).to.equal(null);
      expect(buildFileListingBlock([])).to.equal(null);
    });

    it('lists only top-level entries, ignoring children', () => {
      const entries: FileNode[] = [
        {
          name: 'src',
          path: 'src',
          type: 'dir',
          children: [{ name: 'index.ts', path: 'src/index.ts', type: 'file' }],
        },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ];
      const block = buildFileListingBlock(entries);
      expect(block).to.equal('- src (dir)\n- README.md (file)');
      expect(block).to.not.include('index.ts');
    });
  });

  describe('runPathA() / runPathB()', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'plan-generation-test-'));
      bootObservability(openDatabase(join(dir, 'observability.db')));
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('runPathA returns the model response content', async () => {
      const model = new FakeListChatModel({ responses: ['[{"step": "Go", "done": false}]'] });
      const raw = await runPathA(model, 'a prompt', undefined, undefined);
      expect(raw).to.equal('[{"step": "Go", "done": false}]');
    });

    it('runPathA saves an observability span even on a bare invoke()', async () => {
      const before = getObservabilityStore().find({}).length;
      const model = new FakeListChatModel({ responses: ['[]'] });
      await runPathA(model, 'a prompt', 'local', 'fake-model');
      const after = getObservabilityStore().find({}).length;
      expect(after).to.equal(before + 1);
    });

    it('runPathA rethrows when the model throws', async () => {
      const model = new ThrowingChatModel({});
      let threw = false;
      try {
        await runPathA(model, 'a prompt', undefined, undefined);
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });

    it('runPathB drives a real tool-calling agent loop and returns the final message content', async () => {
      const model = new ScriptedChatModel({});
      const raw = await runPathB(model, 'please plan this', undefined, undefined);
      expect(raw).to.equal('[{"step": "Look into it", "done": false}]');
    });
  });
});
