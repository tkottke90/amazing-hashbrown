import { describe, it } from 'mocha';
import { expect } from 'chai';
import { AppBroadcastEventSchema } from '../../src/chat/broadcast-events.js';

describe('chat/AppBroadcastEventSchema — task_plan_updated', () => {
  it('accepts a task_plan_updated event carrying the full updated plan [unit]', () => {
    const event = {
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [
        { step: 'Scaffold the route', done: true },
        { step: 'Add tests', done: false },
      ],
    };
    const parsed = AppBroadcastEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('accepts an empty plan, so clearing every step is still broadcastable [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [],
    });
    expect(parsed.success).to.equal(true);
  });

  it('rejects a plan step missing its done flag, so the UI never renders an ambiguous checkbox [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({
      type: 'task_plan_updated',
      taskId: 'task-1',
      plan: [{ step: 'Add tests' }],
    });
    expect(parsed.success).to.equal(false);
  });

  it('rejects an event with no taskId, since the UI has no task to patch [unit]', () => {
    const parsed = AppBroadcastEventSchema.safeParse({ type: 'task_plan_updated', plan: [] });
    expect(parsed.success).to.equal(false);
  });
});
