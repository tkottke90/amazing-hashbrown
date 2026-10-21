import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  EMPTY_TASK_STATE,
  formatTaskFileTimestamp,
  listWorkspaceTaskFiles,
  loadTaskState,
  parseTaskStateFromMarkdown,
  renderTaskStateToMarkdown,
  writeTaskFile,
  type TaskState,
} from './task-file.js';

describe('task-file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-file-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('renderTaskStateToMarkdown / parseTaskStateFromMarkdown', () => {
    it('round-trips every field through a render/parse cycle [unit]', () => {
      const state: TaskState = {
        goal: 'Fix the flaky retry test',
        previousTasks: ['task-1: Added retry logic', 'task-2: Wrote the first flaky test'],
        notes: [['Started investigating', 'Found the race condition'], ['Resumed after a crash']],
        outcome: 'Fixed the race condition and the test is green.',
        handoff: 'Watch the next few CI runs for recurrence.',
      };

      const rendered = renderTaskStateToMarkdown(state, { taskId: 't-1', title: 'Fix flaky test' });
      const parsed = parseTaskStateFromMarkdown(rendered);

      expect(parsed).to.deep.equal(state);
    });

    it('round-trips an empty notes array (no runs yet) [unit]', () => {
      const rendered = renderTaskStateToMarkdown(EMPTY_TASK_STATE, { taskId: 't-1', title: 'X' });
      const parsed = parseTaskStateFromMarkdown(rendered);

      expect(parsed).to.deep.equal(EMPTY_TASK_STATE);
    });

    it('round-trips a run segment that has no notes yet [unit]', () => {
      const state: TaskState = { ...EMPTY_TASK_STATE, notes: [[]] };
      const rendered = renderTaskStateToMarkdown(state, { taskId: 't-1', title: 'X' });

      expect(parseTaskStateFromMarkdown(rendered)).to.deep.equal(state);
    });

    it('renders the task title into the body, not just the frontmatter [unit]', () => {
      const rendered = renderTaskStateToMarkdown(EMPTY_TASK_STATE, {
        taskId: 't-1',
        title: 'My Special Task',
      });

      expect(rendered).to.include('My Special Task');
    });
  });

  describe('loadTaskState', () => {
    it('returns an empty state with historyGap when the file is missing [unit]', async () => {
      const result = await loadTaskState(join(dir, 'does-not-exist.md'));

      expect(result).to.deep.equal({ state: EMPTY_TASK_STATE, historyGap: true });
    });

    it('returns an empty state with historyGap when the frontmatter is corrupt [unit]', async () => {
      const filePath = join(dir, 'corrupt.md');
      writeFileSync(
        filePath,
        '---\nnot: [valid, "yaml that matches the schema"\n---\nbody',
        'utf8',
      );

      const result = await loadTaskState(filePath);

      expect(result).to.deep.equal({ state: EMPTY_TASK_STATE, historyGap: true });
    });

    it('returns an empty state with historyGap when frontmatter is missing entirely [unit]', async () => {
      const filePath = join(dir, 'no-frontmatter.md');
      writeFileSync(filePath, 'just some plain markdown, no frontmatter at all', 'utf8');

      const result = await loadTaskState(filePath);

      expect(result).to.deep.equal({ state: EMPTY_TASK_STATE, historyGap: true });
    });

    it('returns the parsed state with historyGap false for a well-formed file [unit]', async () => {
      const state: TaskState = {
        ...EMPTY_TASK_STATE,
        goal: 'Do the thing',
        notes: [['a note']],
      };
      const filePath = join(dir, 'good.md');
      writeFileSync(
        filePath,
        renderTaskStateToMarkdown(state, { taskId: 't-1', title: 'X' }),
        'utf8',
      );

      const result = await loadTaskState(filePath);

      expect(result).to.deep.equal({ state, historyGap: false });
    });
  });

  describe('writeTaskFile', () => {
    it('creates the parent directory and writes the file atomically [unit]', async () => {
      const filePath = join(dir, 'tasks', '20261021000000-t-1.md');
      const state: TaskState = { ...EMPTY_TASK_STATE, goal: 'Written atomically' };

      await writeTaskFile(filePath, state, { taskId: 't-1', title: 'X' });

      expect(existsSync(filePath)).to.equal(true);
      expect(existsSync(`${filePath}.tmp`)).to.equal(false);
      const written = parseTaskStateFromMarkdown(await readFile(filePath, 'utf8'));
      expect(written).to.deep.equal(state);
    });

    it('overwrites an existing file in place rather than failing [unit]', async () => {
      const filePath = join(dir, 'existing.md');
      await writeTaskFile(
        filePath,
        { ...EMPTY_TASK_STATE, goal: 'first' },
        { taskId: 't', title: 'X' },
      );

      await writeTaskFile(
        filePath,
        { ...EMPTY_TASK_STATE, goal: 'second' },
        { taskId: 't', title: 'X' },
      );

      const written = parseTaskStateFromMarkdown(await readFile(filePath, 'utf8'));
      expect(written.goal).to.equal('second');
    });
  });

  describe('formatTaskFileTimestamp', () => {
    it('formats a fixed-width 14-digit timestamp with no separators [unit]', () => {
      const date = new Date(Date.UTC(2026, 9, 21, 9, 5, 3));

      expect(formatTaskFileTimestamp(date)).to.equal('20261021090503');
    });
  });

  describe('listWorkspaceTaskFiles', () => {
    async function writeFileFor(taskId: string, timestamp: string, state: TaskState) {
      const tasksDir = join(dir, '.hashbrown', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      await writeTaskFile(join(tasksDir, `${timestamp}-${taskId}.md`), state, {
        taskId,
        title: 'X',
      });
    }

    it('returns an empty list when the directory does not exist [unit]', async () => {
      expect(await listWorkspaceTaskFiles(dir, 'exclude-me')).to.deep.equal([]);
    });

    it('lists files chronologically by filename, excluding the given task id [unit]', async () => {
      await writeFileFor('task-a', '20261021000001', {
        ...EMPTY_TASK_STATE,
        goal: 'Goal A',
        outcome: 'Outcome A',
      });
      await writeFileFor('task-b', '20261021000002', {
        ...EMPTY_TASK_STATE,
        goal: 'Goal B',
        outcome: 'Outcome B',
      });

      const results = await listWorkspaceTaskFiles(dir, 'task-b');

      expect(results).to.deep.equal([
        { taskId: 'task-a', goal: 'Goal A', outcome: 'Outcome A', createdAt: '20261021000001' },
      ]);
    });

    it('correctly extracts a hyphenated UUID task id from the filename [unit]', async () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      await writeFileFor(uuid, '20261021000000', {
        ...EMPTY_TASK_STATE,
        goal: 'Hyphenated id goal',
      });

      const results = await listWorkspaceTaskFiles(dir, 'some-other-task');

      expect(results).to.deep.equal([
        { taskId: uuid, goal: 'Hyphenated id goal', outcome: '', createdAt: '20261021000000' },
      ]);
    });

    it('skips one malformed file among several good ones, without throwing [unit]', async () => {
      await writeFileFor('task-a', '20261021000001', { ...EMPTY_TASK_STATE, goal: 'Goal A' });
      const tasksDir = join(dir, '.hashbrown', 'tasks');
      writeFileSync(
        join(tasksDir, '20261021000002-task-bad.md'),
        'not valid frontmatter at all',
        'utf8',
      );
      await writeFileFor('task-c', '20261021000003', { ...EMPTY_TASK_STATE, goal: 'Goal C' });

      const results = await listWorkspaceTaskFiles(dir, 'exclude-nothing');

      expect(results.map((r) => r.taskId)).to.deep.equal(['task-a', 'task-c']);
    });
  });
});
