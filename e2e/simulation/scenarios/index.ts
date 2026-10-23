import type { ScenarioDefinition } from '../types.js';
import { bootstrapFailure } from './bootstrap-failure.js';
import { cloudformationFailure } from './cloudformation-failure.js';
import { cloudformationRollback } from './cloudformation-rollback.js';
import { databaseFailure } from './database-failure.js';
import { deleteFailure } from './delete-failure.js';
import { rdsAzCapacity } from './rds-az-capacity.js';
import { ecsFailure } from './ecs-failure.js';
import { happyPath } from './happy-path.js';
import { healthcheckFailure } from './healthcheck-failure.js';
import { lifecycleSweep } from './lifecycle-sweep.js';
import { migrationFailure } from './migration-failure.js';
import { configUpdateFailure } from './config-update-failure.js';
import { migrationCorrection } from './migration-correction.js';
import { migrationSuccess } from './migration-success.js';
import { multiWorkerSweep } from './multi-worker-sweep.js';
import { mysqlSweep } from './mysql-sweep.js';
import { phase4Composition } from './phase4-composition.js';
import { phase5Composition } from './phase5-composition.js';
import { purgeFailure } from './purge-failure.js';
import { redisFailure } from './redis-failure.js';
import { redisSuccess } from './redis-success.js';
import { relayDisconnect } from './relay-disconnect.js';
import { retainedDeleteRecovery } from './retained-delete-recovery.js';
import { retainedResources } from './retained-resources.js';
import { rollbackFailure } from './rollback-failure.js';
import { rollbackSuccess } from './rollback-success.js';
import { slowProvision } from './slow-provision.js';
import { staleInstallResurrect } from './stale-install-resurrect.js';
import { transientAws } from './transient-aws.js';
import { stateless } from './stateless.js';
import { updateFailure } from './update-failure.js';
import { vendorDispute } from './vendor-dispute.js';

/**
 * Registry of implemented scenarios. Phase 1 D1 (provisioning-side failures)
 * added slow-provision, cloudformation-failure, database-failure,
 * redis-failure, bootstrap-failure and relay-disconnect on top of the
 * original happy-path/cloudformation-rollback/ecs-failure/healthcheck-failure
 * four. Phase 1 D2 (lifecycle: update/rollback/destroy) adds update-failure,
 * rollback-success, rollback-failure, delete-failure and retained-resources.
 * Phase 14 adds lifecycle-sweep (one continuous lifecycle over a single
 * deployment) and redis-success (a successful Redis install). purge-failure
 * adds a deterministic PURGE-sweep failure (an orphan the sweep cannot
 * delete) on top of retained-resources' clean destroy.
 * retained-delete-recovery proves the relay's data-preserving DELETE_FAILED
 * recovery: the first delete fails on the retained-database cascade, the
 * RetainResources retry completes it, and PURGE removes the retained data.
 */
const SCENARIOS: Readonly<Record<string, ScenarioDefinition>> = {
  [happyPath.id]: happyPath,
  [cloudformationRollback.id]: cloudformationRollback,
  [ecsFailure.id]: ecsFailure,
  [healthcheckFailure.id]: healthcheckFailure,
  [lifecycleSweep.id]: lifecycleSweep,
  [migrationFailure.id]: migrationFailure,
  [configUpdateFailure.id]: configUpdateFailure,
  [migrationCorrection.id]: migrationCorrection,
  [migrationSuccess.id]: migrationSuccess,
  [multiWorkerSweep.id]: multiWorkerSweep,
  [mysqlSweep.id]: mysqlSweep,
  [phase4Composition.id]: phase4Composition,
  [phase5Composition.id]: phase5Composition,
  [slowProvision.id]: slowProvision,
  [staleInstallResurrect.id]: staleInstallResurrect,
  [cloudformationFailure.id]: cloudformationFailure,
  [databaseFailure.id]: databaseFailure,
  [rdsAzCapacity.id]: rdsAzCapacity,
  [redisFailure.id]: redisFailure,
  [redisSuccess.id]: redisSuccess,
  [bootstrapFailure.id]: bootstrapFailure,
  [relayDisconnect.id]: relayDisconnect,
  [updateFailure.id]: updateFailure,
  [rollbackSuccess.id]: rollbackSuccess,
  [rollbackFailure.id]: rollbackFailure,
  [deleteFailure.id]: deleteFailure,
  [retainedResources.id]: retainedResources,
  [retainedDeleteRecovery.id]: retainedDeleteRecovery,
  [purgeFailure.id]: purgeFailure,
  [transientAws.id]: transientAws,
  [stateless.id]: stateless,
  [vendorDispute.id]: vendorDispute,
};

export function getScenario(id: string): ScenarioDefinition {
  const scenario = SCENARIOS[id];
  if (!scenario) {
    throw new Error(
      `Unknown deployz E2E scenario "${id}" — known scenarios: ${Object.keys(SCENARIOS).join(', ')}`,
    );
  }
  return scenario;
}

export {
  bootstrapFailure,
  cloudformationFailure,
  cloudformationRollback,
  databaseFailure,
  deleteFailure,
  ecsFailure,
  rdsAzCapacity,
  happyPath,
  healthcheckFailure,
  lifecycleSweep,
  migrationFailure,
  configUpdateFailure,
  migrationCorrection,
  migrationSuccess,
  multiWorkerSweep,
  mysqlSweep,
  phase4Composition,
  phase5Composition,
  purgeFailure,
  redisFailure,
  redisSuccess,
  relayDisconnect,
  retainedDeleteRecovery,
  retainedResources,
  rollbackFailure,
  rollbackSuccess,
  slowProvision,
  staleInstallResurrect,
  transientAws,
  stateless,
  updateFailure,
  vendorDispute,
};
