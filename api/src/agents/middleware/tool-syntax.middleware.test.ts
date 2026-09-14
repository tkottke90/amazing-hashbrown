import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createToolSyntaxMiddleware } from './tool-syntax.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeState(messages: any[]): { messages: any[] } {
  return { messages };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callBeforeAgent(middleware: any, state: { messages: any[] }): Promise<unknown> {
  return middleware.beforeAgent(state);
}

// Token-extraction correctness (single/multiple/dedup/punctuation/etc.) is
// already covered by tool-syntax.test.ts's direct unit tests of
// extractRequestedToolIds() — this suite only needs to prove the wiring:
// finds the right message, calls the pure function on it, and never mutates
// message content.
describe('agents/middleware/tool-syntax.middleware', () => {
  it('returns requestedToolIds when the latest human message has a # token', async () => {
    const middleware = createToolSyntaxMiddleware();
    const state = makeState([new HumanMessage('#web_fetch check this article')]);
    const result = await callBeforeAgent(middleware, state);
    expect(result).to.deep.equal({ requestedToolIds: ['web_fetch'] });
  });

  it('returns undefined (no state write) when there is no # token', async () => {
    const middleware = createToolSyntaxMiddleware();
    const state = makeState([new HumanMessage('just a plain message')]);
    const result = await callBeforeAgent(middleware, state);
    expect(result).to.equal(undefined);
  });

  it('returns undefined when there is no human message at all', async () => {
    const middleware = createToolSyntaxMiddleware();
    const state = makeState([new AIMessage('hello')]);
    const result = await callBeforeAgent(middleware, state);
    expect(result).to.equal(undefined);
  });

  it('uses the LATEST human message, not an earlier one', async () => {
    const middleware = createToolSyntaxMiddleware();
    const state = makeState([
      new HumanMessage('#web_fetch earlier turn'),
      new AIMessage('ok, fetched it'),
      new HumanMessage('now summarize without any tag'),
    ]);
    const result = await callBeforeAgent(middleware, state);
    expect(result).to.equal(undefined);
  });

  it('never mutates message content', async () => {
    const middleware = createToolSyntaxMiddleware();
    const original = new HumanMessage('#web_fetch check this');
    const state = makeState([original]);
    await callBeforeAgent(middleware, state);
    expect(state.messages[0]).to.equal(original);
    expect(state.messages[0].content).to.equal('#web_fetch check this');
  });

  it('detects a token carried through skill-expanded body + trailing args', async () => {
    const middleware = createToolSyntaxMiddleware();
    const expanded =
      'Collect the workspace fields, then call create_workspace.\n\n#web_fetch check this first';
    const state = makeState([new HumanMessage(expanded)]);
    const result = await callBeforeAgent(middleware, state);
    expect(result).to.deep.equal({ requestedToolIds: ['web_fetch'] });
  });
});
