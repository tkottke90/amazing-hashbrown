import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';

/**
 * Boots a real Express app (mounting just the given router at the given
 * base path) on an ephemeral localhost port, so a test can make real HTTP
 * requests against an actual registered route — path matching, param
 * extraction, and all — without needing a new test-HTTP-client dependency.
 * Only `fetch` (Node's built-in) is needed to talk to it.
 *
 * Used for route files that have no supertest/req-res-mock precedent in
 * this repo — the routes here are thin wiring around already-unit-tested
 * logic (e.g. active-sse-writer.ts's stopTurnResponse), so this exists to
 * prove the wiring itself, not to re-test that logic.
 */
export async function startTestServer(
  router: Router,
  basePath: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    // closeAllConnections() first: server.close() alone waits for every open
    // socket, and Node's fetch can leave a spare keep-alive connection open
    // that never carried a request (observed with the events route's SSE
    // tests). server.close() doesn't count that socket as idle, so it hangs
    // until the client's keep-alive timeout — longer than Mocha's 2s hook
    // timeout. Tests have already made their assertions by the time close()
    // runs, so force-closing leftovers here can't mask a server-side bug.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
