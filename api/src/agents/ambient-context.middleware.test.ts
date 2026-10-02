import { describe, it } from 'mocha';
import { expect } from 'chai';
import { SystemMessage } from '@langchain/core/messages';
import { createAmbientContextMiddleware } from './ambient-context.middleware.js';

enum TestTypes {
  UNIT = '[unit]',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRequest(system: SystemMessage): any {
  return { systemMessage: system };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = any;

describe('agents/ambient-context.middleware', () => {
  it(`appends an ambient_context block to the base system prompt ${TestTypes.UNIT}`, async () => {
    const middleware: AnyMiddleware = createAmbientContextMiddleware(
      () => new Date('2026-09-26T17:05:00.000Z'),
    );
    let seenContent: unknown;

    await middleware.wrapModelCall(
      fakeRequest(new SystemMessage('base prompt')),
      async (req: { systemMessage: SystemMessage }) => {
        seenContent = req.systemMessage.content;
        return {};
      },
    );

    expect(seenContent).to.equal(
      'base prompt\n\n<ambient_context>\nCurrent date and time: 2026-09-26 17:05 UTC. "Today," "tomorrow," and similar relative dates resolve against this.\n</ambient_context>',
    );
  });

  it(`renders a different value on a later call, even on the same middleware instance ${TestTypes.UNIT}`, async () => {
    // This is the test that directly proves the staleness bug (issue #244) is
    // fixed: a cached agent reuses the same middleware for every turn, so the
    // date must be recomputed fresh per call, never captured once.
    let now = new Date('2026-09-26T17:05:00.000Z');
    const middleware: AnyMiddleware = createAmbientContextMiddleware(() => now);
    const seen: unknown[] = [];
    const handler = async (req: { systemMessage: SystemMessage }) => {
      seen.push(req.systemMessage.content);
      return {};
    };

    await middleware.wrapModelCall(fakeRequest(new SystemMessage('base prompt')), handler);
    now = new Date('2026-09-27T09:00:00.000Z');
    await middleware.wrapModelCall(fakeRequest(new SystemMessage('base prompt')), handler);

    expect(seen[0]).to.not.equal(seen[1]);
    expect(seen[0]).to.include('2026-09-26 17:05 UTC');
    expect(seen[1]).to.include('2026-09-27 09:00 UTC');
  });

  it(`still injects ambient context when the system message content is a structured array, not a plain string ${TestTypes.UNIT}`, async () => {
    // Regression test: this used to pass the request through unmodified
    // (skipping ambient context entirely) whenever systemMessage.content
    // wasn't a plain string — which happens on any turn whose messages
    // include structured multimodal content (e.g. an attached image), not
    // just some theoretical case. getMessageText() must recover the text so
    // this middleware keeps doing its job on a multimodal turn too.
    const middleware: AnyMiddleware = createAmbientContextMiddleware(
      () => new Date('2026-09-26T17:05:00.000Z'),
    );
    const structured = new SystemMessage({ content: [{ type: 'text', text: 'structured' }] });
    let seenContent: unknown;

    await middleware.wrapModelCall(
      fakeRequest(structured),
      async (req: { systemMessage: SystemMessage }) => {
        seenContent = req.systemMessage.content;
        return {};
      },
    );

    expect(seenContent).to.equal(
      'structured\n\n<ambient_context>\nCurrent date and time: 2026-09-26 17:05 UTC. "Today," "tomorrow," and similar relative dates resolve against this.\n</ambient_context>',
    );
  });
});
