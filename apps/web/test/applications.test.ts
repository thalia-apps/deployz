import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchApplicationPlan, triggerAnalysis, updateApplication } from '../src/lib/applications';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubError(status: number, code: string, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code, message } }), { status })),
  );
}

describe('application request errors', () => {
  it('carries the API message when an update is refused', async () => {
    stubError(400, 'VALIDATION_ERROR', 'Enter a port between 1 and 65535.');
    await expect(updateApplication('app-1', { containerPort: 0 })).rejects.toThrow('Enter a port between 1 and 65535.');
  });

  it('carries the API message when analysis cannot start', async () => {
    stubError(409, 'ANALYSIS_IN_PROGRESS', 'An analysis is already running.');
    await expect(triggerAnalysis('app-1', { force: true })).rejects.toThrow('An analysis is already running.');
  });

  it('carries the API message when the plan is not ready', async () => {
    stubError(409, 'ANALYSIS_NOT_COMPLETE', 'The analysis has not finished.');
    await expect(fetchApplicationPlan('app-1')).rejects.toThrow('The analysis has not finished.');
  });
});
