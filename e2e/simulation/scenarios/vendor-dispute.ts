import type { ScenarioDefinition } from '../types.js';
import { stateless } from './stateless.js';

/**
 * A vendor dispute ends in an ordinary stateless install: the vendor marks
 * the MongoDB blocker of deployz-demo/mongodb-app as "not used in
 * production", the re-analysis drops it, and the deployment provisions no
 * database (docs/ai-analysis.md#vendor-disputes).
 */
export const vendorDispute: ScenarioDefinition = {
  ...stateless,
  id: 'vendor-dispute',
  description:
    'After a vendor dispute removes a false MongoDB blocker, the install reaches HEALTHY with no database (the stateless timeline).',
};
