import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore, type PlanStep } from '../services/workspace-store.js';
import {
  cloneEmptyTaskState,
  writeTaskFile,
  loadTaskState,
  type TaskState,
} from '../services/task-file.js';
import { createTaskFileStateMiddleware, mergeTaskState } from './task-file-state.middleware.js';
import { makeWriteTaskNoteTool } from './tools/write-task-note.tool.js';
import { makeUpdatePlanTool } from './tools/update-plan.tool.js';

describe('agents/task-file-state.middleware', () => {
  describe('mergeTaskState [unit]', () => {
    it('appends a single note to an empty state', () => {
      const result = mergeTaskState(cloneEmptyTaskState(), { appendNotes: ['a'] });
      expect(result.notes).to.deep.equal([['a']]);
    });

    it('appends multiple notes from one delta in one call', () => {
      const result = mergeTaskState(cloneEmptyTaskState(), { appendNotes: ['a', 'b'] });
      expect(result.notes).to.deep.equal([['a', 'b']]);
    });

    it('folds sequential deltas the same way BinaryOperatorAggregate.update does', () => {
      const start = cloneEmptyTaskState();
      const afterFirst = mergeTaskState(start, { appendNotes: ['a'] });
      const afterSecond = mergeTaskState(afterFirst, { appendNotes: ['b'] });
      expect(afterSecond.notes).to.deep.equal([['a', 'b']]);
    });

    it('appends onto the existing run segment when notes already has entries', () => {
      const current: TaskState = { ...cloneEmptyTaskState(), notes: [['earlier run'], ['a']] };
      const result = mergeTaskState(current, { appendNotes: ['b'] });
      expect(result.notes).to.deep.equal([['earlier run'], ['a', 'b']]);
    });

    it('returns the exact same object reference when appendNotes is empty', () => {
      const current = cloneEmptyTaskState();
      expect(mergeTaskState(current, { appendNotes: [] })).to.equal(current);
    });

    it('leaves goal, previousTasks, outcome, and handoff untouched', () => {
      const current: TaskState = {
        goal: 'Fix the bug',
        previousTasks: ['t-1: done'],
        notes: [['a']],
        outcome: '',
        handoff: '',
      };
      const result = mergeTaskState(current, { appendNotes: ['b'] });
      expect(result.goal).to.equal(current.goal);
      expect(result.previousTasks).to.equal(current.previousTasks);
      expect(result.outcome).to.equal(current.outcome);
      expect(result.handoff).to.equal(current.handoff);
    });
  });

  describe('Task File persistence (beforeModel/afterAgent hooks)', () => {
    let fsDir: string;
    let dbDir: string;
    let store: WorkspaceStore;

    beforeEach(() => {
      fsDir = mkdtempSync(join(tmpdir(), 'task-file-state-fs-'));
      dbDir = mkdtempSync(join(tmpdir(), 'task-file-state-db-'));
      store = new WorkspaceStore(openDatabase(join(dbDir, 'test.db')));
    });

    afterEach(() => {
      rmSync(fsDir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    });

    class SingleToolCallModel extends BaseChatModel {
      _llmType() {
        return 'scripted-fake';
      }
      bindTools() {
        return this;
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const last = messages[messages.length - 1]!;
        if (last.getType() === 'tool') {
          return { generations: [{ message: new AIMessage('Noted.'), text: 'Noted.' }] };
        }
        return {
          generations: [
            {
              message: new AIMessage({
                content: '',
                tool_calls: [{ id: 'call_1', name: 'write_task_note', args: { note: 'a note' } }],
              }),
              text: '',
            },
          ],
        };
      }
    }

    it('does not throw when the Task File write fails [orchestration]', async () => {
      const task = store.createTask({ title: 'T' });
      // A plain file sitting where a directory component needs to be —
      // mkdir(dirname(filePath), { recursive: true }) fails against this,
      // so writeTaskFile rejects.
      const blocker = join(fsDir, 'blocker-file');
      writeFileSync(blocker, 'not a directory', 'utf8');
      const badPath = join(blocker, 'sub', 'file.md');

      const checkpointer = new SqliteSaver(new Database(join(fsDir, 'checkpoints.db')));
      const agent = createAgent({
        model: new SingleToolCallModel({}),
        tools: [makeWriteTaskNoteTool()],
        middleware: [createTaskFileStateMiddleware(task.id, { filePath: badPath }, store)],
        checkpointer,
      });
      const config = { configurable: { thread_id: 'thread-1' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'please note this' }] }, config);

      const state = await agent.getState(config);
      expect(state.values.taskState.notes).to.deep.equal([['a note']]);
    });

    it('is a no-op when no Task File exists for this run [orchestration]', async () => {
      const task = store.createTask({ title: 'T' });
      const checkpointer = new SqliteSaver(new Database(join(fsDir, 'checkpoints.db')));
      let persistCalls = 0;
      const agent = createAgent({
        model: new SingleToolCallModel({}),
        tools: [makeWriteTaskNoteTool()],
        middleware: [
          createTaskFileStateMiddleware(
            task.id,
            undefined,
            store,
            async (...args: Parameters<typeof writeTaskFile>) => {
              persistCalls += 1;
              return writeTaskFile(...args);
            },
          ),
        ],
        checkpointer,
      });
      const config = { configurable: { thread_id: 'thread-1' } };

      await agent.invoke({ messages: [{ role: 'human', content: 'please note this' }] }, config);

      expect(persistCalls).to.equal(0);
      const state = await agent.getState(config);
      expect(state.values.taskState.notes).to.deep.equal([['a note']]);
    });

    const PLAN: PlanStep[] = [
      { step: 'Scaffold the route', done: false },
      { step: 'Add tests', done: false },
    ];

    class BothToolsInOneTurnModel extends BaseChatModel {
      _llmType() {
        return 'scripted-fake';
      }
      bindTools() {
        return this;
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        const last = messages[messages.length - 1]!;
        if (last.getType() === 'tool') {
          return { generations: [{ message: new AIMessage('Done.'), text: 'Done.' }] };
        }
        // The exact scenario issue #362 crashed on: two tools that each
        // write the taskState channel, called in the same turn.
        return {
          generations: [
            {
              message: new AIMessage({
                content: '',
                tool_calls: [
                  { id: 'call_1', name: 'write_task_note', args: { note: 'agent note' } },
                  {
                    id: 'call_2',
                    name: 'update_plan',
                    args: { updates: [{ step: 1, done: true }] },
                  },
                ],
              }),
              text: '',
            },
          ],
        };
      }
    }

    it(
      'merges both tool calls when the model calls write_task_note and update_plan ' +
        'in the same turn, and persists the merged state exactly once [orchestration]',
      async () => {
        const task = store.createTask({ title: 'Ship the endpoint', plan: PLAN });
        const filePath = join(fsDir, `t-${task.id}.md`);
        const checkpointer = new SqliteSaver(new Database(join(fsDir, 'checkpoints.db')));
        const persistCalls: TaskState[] = [];

        const agent = createAgent({
          model: new BothToolsInOneTurnModel({}),
          tools: [makeWriteTaskNoteTool(), makeUpdatePlanTool(task.id, store, { filePath })],
          middleware: [
            createTaskFileStateMiddleware(
              task.id,
              { filePath },
              store,
              async (...args: Parameters<typeof writeTaskFile>) => {
                persistCalls.push(args[1]);
                return writeTaskFile(...args);
              },
            ),
          ],
          checkpointer,
        });
        const config = { configurable: { thread_id: 'thread-1' } };

        // Before the fix, this throws InvalidUpdateError — two parallel
        // tool calls both writing the taskState channel with no reducer.
        await agent.invoke(
          { messages: [{ role: 'human', content: 'note this and check off step 1' }] },
          config,
        );

        const state = await agent.getState(config);
        expect(state.values.taskState.notes).to.have.length(1);
        expect(state.values.taskState.notes[0]).to.have.members([
          'agent note',
          'Step 1 marked done.',
        ]);

        expect(persistCalls).to.have.length(1);
        expect(persistCalls[0]!.notes[0]).to.have.members(['agent note', 'Step 1 marked done.']);

        const { state: fileState } = await loadTaskState(filePath);
        expect(fileState.notes[0]).to.have.members(['agent note', 'Step 1 marked done.']);
      },
    );
  });
});
