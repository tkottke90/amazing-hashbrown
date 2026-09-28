import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { startTestServer } from '../../../tests/utilities/http-test-server.js';
import { toolSettingsRouter } from './tool-settings.route.js';

// Wiring only — validation itself is unit-tested in
// tool-settings.handlers.test.ts. This proves per-row env errors survive the
// route's serialization so the drawer can render them in place (issue #220).
// Every request here is invalid, so nothing is written to the config dir.
describe('routes/v1/tool-settings — PATCH failure body', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ baseUrl, close } = await startTestServer(toolSettingsRouter, '/api/v1/tool-settings'));
  });

  afterEach(async () => {
    await close();
  });

  it('returns fieldErrors keyed by env row alongside the summary error [orchestration]', async () => {
    const res = await fetch(`${baseUrl}/shell_exec`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: { gh_token: 'x', MISSING: '${UNSET_ROUTE_VAR_220}' } }),
    });

    expect(res.status).to.equal(400);
    const body = (await res.json()) as {
      error: string;
      fieldErrors: Record<string, string[]>;
    };
    expect(body.error).to.be.a('string').with.length.greaterThan(0);
    expect(Object.keys(body.fieldErrors)).to.have.members(['env.gh_token', 'env.MISSING']);
  });

  it('omits fieldErrors for a failure that is not about a specific row [orchestration]', async () => {
    const res = await fetch(`${baseUrl}/no_such_tool`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).to.equal(404);
    expect(await res.json()).to.not.have.property('fieldErrors');
  });
});
