import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  setActiveSseWriter,
  getActiveSseWriter,
  getActiveTurnAbort,
  clearActiveSseWriter,
  stopActiveTurn,
  stopTurnResponse,
} from './active-sse-writer.js';

describe('agents/active-sse-writer', () => {
  const threadId = 'thread-active-sse-writer-test';

  afterEach(() => {
    clearActiveSseWriter(threadId);
  });

  it('stores and returns the writer for a thread [unit]', () => {
    const writer = () => {};
    setActiveSseWriter(threadId, writer);
    expect(getActiveSseWriter(threadId)).to.equal(writer);
  });

  it('stores and returns the controller when one is passed [unit]', () => {
    const controller = new AbortController();
    setActiveSseWriter(threadId, () => {}, controller);
    expect(getActiveTurnAbort(threadId)).to.equal(controller);
  });

  it("leaves getActiveTurnAbort undefined when no controller is passed, matching task-execution.ts's existing usage [unit]", () => {
    setActiveSseWriter(threadId, () => {});
    expect(getActiveTurnAbort(threadId)).to.equal(undefined);
  });

  it('clears both the writer and the controller [unit]', () => {
    const controller = new AbortController();
    setActiveSseWriter(threadId, () => {}, controller);
    clearActiveSseWriter(threadId);
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
    expect(getActiveTurnAbort(threadId)).to.equal(undefined);
  });

  describe('stopActiveTurn', () => {
    it('returns false and does not throw when nothing is registered for the thread [unit]', () => {
      expect(stopActiveTurn(threadId)).to.equal(false);
    });

    it('aborts the registered controller and returns true [unit]', () => {
      const controller = new AbortController();
      setActiveSseWriter(threadId, () => {}, controller);

      const stopped = stopActiveTurn(threadId);

      expect(stopped).to.equal(true);
      expect(controller.signal.aborted).to.equal(true);
    });

    it('returns false again once the entry has been cleared [unit]', () => {
      const controller = new AbortController();
      setActiveSseWriter(threadId, () => {}, controller);
      clearActiveSseWriter(threadId);

      expect(stopActiveTurn(threadId)).to.equal(false);
    });
  });

  describe('stopTurnResponse', () => {
    it('returns a 409 with an error body when nothing is active [unit]', () => {
      const result = stopTurnResponse(threadId);
      expect(result).to.deep.equal({
        status: 409,
        body: { error: 'No active turn for this thread' },
      });
    });

    it('returns a 202 ok body and aborts the controller when a turn is active [unit]', () => {
      const controller = new AbortController();
      setActiveSseWriter(threadId, () => {}, controller);

      const result = stopTurnResponse(threadId);

      expect(result).to.deep.equal({ status: 202, body: { ok: true } });
      expect(controller.signal.aborted).to.equal(true);
    });

    it('returns a 409 for a task-owned thread (writer set, no controller) [unit]', () => {
      // Simulates task-execution.ts's usage — it registers a writer but
      // never a controller, so the interactive-chat /stop route must not
      // be able to abort a task run through this path.
      setActiveSseWriter(threadId, () => {});
      const result = stopTurnResponse(threadId);
      expect(result.status).to.equal(409);
    });
  });
});
