import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createCustomerSession, customerCookieNames } from './customer-access.js';
import { normalizeEmail } from './organizations.js';

/**
 * Tests only: the cookie header of a signed-in customer whose email is the
 * customer record of the deployment the link names — what a verified email
 * code gives in production (docs/customer-access.md).
 */
export async function customerSessionHeaders(db: RuntimeDb, installLinkId: string): Promise<Record<string, string>> {
  const [row] = await db
    .select({ email: schema.customers.email })
    .from(schema.deployments)
    .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
    .where(eq(schema.deployments.installLinkId, installLinkId))
    .limit(1);
  if (!row) throw new Error(`No deployment with install link ${installLinkId}`);
  const { token } = await createCustomerSession(db, normalizeEmail(row.email), new Date());
  return { cookie: `${customerCookieNames().session}=${token}` };
}
