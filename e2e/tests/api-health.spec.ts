import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';

const suite: TestSuite = {
  id: 2,
  name: 'API Health Check',
  description: 'Verifies the API server is running and reports healthy status',
  purpose: 'Ensure the API server starts correctly and the health endpoint is reachable',
  tags: ['@smoke', '@functional'],
  steps: [
    {
      tags: ['@smoke', '@functional'],
      action: 'Send GET /api/v1/health',
      expectedOutcome: 'Response is 200 with body { status: "ok" }',
      test: () => {},
    },
  ],
};

test.describe(
  '@smoke @functional',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('GET /api/v1/health returns 200 with status ok', async ({ request }) => {
      const response = await request.get('http://localhost:3000/api/v1/health');
      expect(response.status()).toBe(200);
      const body = (await response.json()) as unknown;
      expect(body).toEqual({ status: 'ok' });
    });
  },
);
