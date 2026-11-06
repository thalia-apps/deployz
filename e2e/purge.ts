import type { APIRequestContext } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * Starts a purge as the dashboard does: the API needs the application name
 * as confirmation. Pass the signed-in `request`.
 */
export async function purgeDeployment(request: APIRequestContext, deploymentId: string) {
  const detail = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
  const { applicationName } = (await detail.json()) as { applicationName: string };
  return request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, {
    data: { confirmName: applicationName },
  });
}
