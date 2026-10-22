import type { APIRequestContext } from '@playwright/test';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * The secret a customer's install URL carries as its fragment. A test that
 * plays the customer reads it through the vendor session, as the dashboard's
 * copy button does.
 */
export async function installLinkToken(request: APIRequestContext, installLinkId: string): Promise<string> {
  const response = await request.get(`${API_URL}/api/deployments`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments -> ${response.status()}`);
  }
  const { deployments } = (await response.json()) as {
    deployments: Array<{ installLinkId: string; installLinkToken: string }>;
  };
  const deployment = deployments.find((candidate) => candidate.installLinkId === installLinkId);
  if (!deployment) {
    throw new Error(`No deployment with install link ${installLinkId}`);
  }
  return deployment.installLinkToken;
}

/** The header the public install routes need for the relay enrollment material and the retry. */
export async function installLinkHeaders(
  request: APIRequestContext,
  installLinkId: string,
): Promise<Record<string, string>> {
  return { 'x-deployz-token': await installLinkToken(request, installLinkId) };
}

/** The customer's install URL with its fragment secret, as the vendor shares it. */
export async function installLinkPath(request: APIRequestContext, installLinkId: string): Promise<string> {
  return `/install/${installLinkId}#${await installLinkToken(request, installLinkId)}`;
}
