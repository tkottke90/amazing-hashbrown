import { test, expect } from '@playwright/test';

const suite = {
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
    annotation: [
      { type: 'suite.id', description: String(suite.id) },
      { type: 'suite.name', description: suite.name },
      { type: 'suite.description', description: suite.description },
      { type: 'suite.purpose', description: suite.purpose },
    ],
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
