import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { bootObservability, getObservabilityStore } from '../services/observability.js';
import { configManager } from '../config/env.js';
import { EMPTY_TASK_STATE, type TaskState } from '../services/task-file.js';
import { generateHandoffNotes, generateTaskGoal } from './task-file-generators.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

describe('task-file-generators', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-file-generators-test-'));
    bootObservability(openDatabase(join(dir, 'observability.db')));
    configManager.set('providers', [
      {
        name: 'local',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'default-model',
      },
    ]);
    configManager.set('defaultProvider', 'local');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  describe('generateTaskGoal', () => {
    it('returns the model response, trimmed [unit]', async () => {
      const model = new FakeListChatModel({ responses: ['  Fix the flaky test.  '] });

      const goal = await generateTaskGoal(model, 'local', 'default-model', {
        task: { title: 'Fix flaky test', description: null, outcome: null, plan: null },
        previousTasks: [],
      });

      expect(goal).to.equal('Fix the flaky test.');
    });

    it('includes title/description/outcome/plan in the prompt [unit]', async () => {
      let capturedPrompt = '';
      class CapturingModel extends FakeListChatModel {
        override async invoke(input: unknown, options?: unknown) {
          capturedPrompt = String(input);
          return super.invoke(input, options as never);
        }
      }
      const model = new CapturingModel({ responses: ['A goal'] });

      await generateTaskGoal(model, 'local', 'default-model', {
        task: {
          title: 'My Title',
          description: 'My Description',
          outcome: 'My Outcome',
          plan: [{ step: 'Do a thing', done: false }],
        },
        previousTasks: [],
      });

      expect(capturedPrompt).to.include('My Title');
      expect(capturedPrompt).to.include('My Description');
      expect(capturedPrompt).to.include('My Outcome');
      expect(capturedPrompt).to.include('Do a thing');
    });

    it('includes previousTasks in the prompt when present [unit]', async () => {
      let capturedPrompt = '';
      class CapturingModel extends FakeListChatModel {
        override async invoke(input: unknown, options?: unknown) {
          capturedPrompt = String(input);
          return super.invoke(input, options as never);
        }
      }
      const model = new CapturingModel({ responses: ['A goal'] });

      await generateTaskGoal(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        previousTasks: ['task-1: Did a thing'],
      });

      expect(capturedPrompt).to.include('task-1: Did a thing');
    });

    it('degrades to an empty string when the model throws, rather than rethrowing [unit]', async () => {
      const model = new ThrowingChatModel({});

      const goal = await generateTaskGoal(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        previousTasks: [],
      });

      expect(goal).to.equal('');
    });

    it('saves an observability span with source=task-file-goal [orchestration]', async () => {
      const before = getObservabilityStore().find({}).length;
      const model = new FakeListChatModel({ responses: ['A goal'] });

      await generateTaskGoal(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        previousTasks: [],
      });

      const after = getObservabilityStore().find({}).length;
      expect(after).to.equal(before + 1);
    });

    describe('token-budget capping of previousTasks [unit]', () => {
      afterEach(() => {
        configManager.set('chat', {});
      });

      it('omits the oldest previousTasks entries and adds the count marker when the budget is exceeded', async () => {
        configManager.set('chat', { contextWindow: { maxTokens: 4000 } }); // budget ~1000 tokens
        let capturedPrompt = '';
        class CapturingModel extends FakeListChatModel {
          override async invoke(input: unknown, options?: unknown) {
            capturedPrompt = String(input);
            return super.invoke(input, options as never);
          }
        }
        const model = new CapturingModel({ responses: ['A goal'] });
        const previousTasks = Array.from({ length: 50 }, (_, i) => `task-${i}: ${'x'.repeat(200)}`);

        await generateTaskGoal(model, 'local', 'default-model', {
          task: { title: 'T', description: null, outcome: null, plan: null },
          previousTasks,
        });

        expect(capturedPrompt).to.include('earlier tasks not shown.');
        expect(capturedPrompt).to.include(previousTasks[previousTasks.length - 1]!);
        expect(capturedPrompt).to.not.include(previousTasks[0]!);
      });

      it('includes no marker when previousTasks fits entirely within budget', async () => {
        let capturedPrompt = '';
        class CapturingModel extends FakeListChatModel {
          override async invoke(input: unknown, options?: unknown) {
            capturedPrompt = String(input);
            return super.invoke(input, options as never);
          }
        }
        const model = new CapturingModel({ responses: ['A goal'] });

        await generateTaskGoal(model, 'local', 'default-model', {
          task: { title: 'T', description: null, outcome: null, plan: null },
          previousTasks: ['task-1: small'],
        });

        expect(capturedPrompt).to.not.include('not shown');
      });
    });
  });

  describe('generateHandoffNotes', () => {
    const state: TaskState = { ...EMPTY_TASK_STATE, outcome: 'It worked.', notes: [['a note']] };

    it('returns the model response, trimmed [unit]', async () => {
      const model = new FakeListChatModel({ responses: ['  Watch the next CI run.  '] });

      const notes = await generateHandoffNotes(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        state,
      });

      expect(notes).to.equal('Watch the next CI run.');
    });

    it("includes the run's outcome and accumulated notes in the prompt [unit]", async () => {
      let capturedPrompt = '';
      class CapturingModel extends FakeListChatModel {
        override async invoke(input: unknown, options?: unknown) {
          capturedPrompt = String(input);
          return super.invoke(input, options as never);
        }
      }
      const model = new CapturingModel({ responses: ['Notes'] });

      await generateHandoffNotes(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        state,
      });

      expect(capturedPrompt).to.include('It worked.');
      expect(capturedPrompt).to.include('a note');
    });

    it('degrades to an empty string when the model throws, rather than rethrowing [unit]', async () => {
      const model = new ThrowingChatModel({});

      const notes = await generateHandoffNotes(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        state,
      });

      expect(notes).to.equal('');
    });

    it('saves an observability span with source=task-file-handoff [orchestration]', async () => {
      const before = getObservabilityStore().find({}).length;
      const model = new FakeListChatModel({ responses: ['Notes'] });

      await generateHandoffNotes(model, 'local', 'default-model', {
        task: { title: 'T', description: null, outcome: null, plan: null },
        state,
      });

      const after = getObservabilityStore().find({}).length;
      expect(after).to.equal(before + 1);
    });

    describe('token-budget capping of notes [unit]', () => {
      afterEach(() => {
        configManager.set('chat', {});
      });

      it('omits the oldest run segments and adds the run-count marker when the budget is exceeded', async () => {
        configManager.set('chat', { contextWindow: { maxTokens: 4000 } });
        let capturedPrompt = '';
        class CapturingModel extends FakeListChatModel {
          override async invoke(input: unknown, options?: unknown) {
            capturedPrompt = String(input);
            return super.invoke(input, options as never);
          }
        }
        const model = new CapturingModel({ responses: ['Notes'] });
        const manyRunsState: TaskState = {
          ...EMPTY_TASK_STATE,
          outcome: 'It worked.',
          notes: Array.from({ length: 30 }, (_, i) => [`run ${i} note: ${'x'.repeat(200)}`]),
        };

        await generateHandoffNotes(model, 'local', 'default-model', {
          task: { title: 'T', description: null, outcome: null, plan: null },
          state: manyRunsState,
        });

        expect(capturedPrompt).to.include('earlier run(s) of notes not shown.');
        expect(capturedPrompt).to.include('run 29 note');
        expect(capturedPrompt).to.not.include('run 0 note');
      });

      it('falls back to a partial last segment when even the single most-recent run does not fit', async () => {
        // maxTokens has a schema-enforced minimum of 4000 (ContextWindowSchema);
        // use that floor directly so the override actually validates, rather than
        // silently falling back to the 32000 default. Budget is 25% of that, i.e.
        // 1000 tokens (~4000 chars) — 'x'.repeat(5000) alone already exceeds it.
        configManager.set('chat', { contextWindow: { maxTokens: 4000 } });
        let capturedPrompt = '';
        class CapturingModel extends FakeListChatModel {
          override async invoke(input: unknown, options?: unknown) {
            capturedPrompt = String(input);
            return super.invoke(input, options as never);
          }
        }
        const model = new CapturingModel({ responses: ['Notes'] });
        const oneHugeRunState: TaskState = {
          ...EMPTY_TASK_STATE,
          outcome: 'It worked.',
          notes: [['x'.repeat(5000), 'small recent note']],
        };

        await generateHandoffNotes(model, 'local', 'default-model', {
          task: { title: 'T', description: null, outcome: null, plan: null },
          state: oneHugeRunState,
        });

        expect(capturedPrompt).to.include('Run 1:');
        expect(capturedPrompt).to.include('small recent note');
        expect(capturedPrompt).to.not.include('x'.repeat(5000));
      });

      it('includes no marker when all note segments fit entirely within budget', async () => {
        let capturedPrompt = '';
        class CapturingModel extends FakeListChatModel {
          override async invoke(input: unknown, options?: unknown) {
            capturedPrompt = String(input);
            return super.invoke(input, options as never);
          }
        }
        const model = new CapturingModel({ responses: ['Notes'] });
        const smallState: TaskState = {
          ...EMPTY_TASK_STATE,
          outcome: 'It worked.',
          notes: [['a note']],
        };

        await generateHandoffNotes(model, 'local', 'default-model', {
          task: { title: 'T', description: null, outcome: null, plan: null },
          state: smallState,
        });

        expect(capturedPrompt).to.not.include('not shown');
      });
    });
  });
});
