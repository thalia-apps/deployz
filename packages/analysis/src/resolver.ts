import {
  CAPABILITY_KEYS,
  type InfrastructureSizeProfile,
  type Resource,
} from '@deployz/contracts';

// ---------------------------------------------------------------------------
// Resolver — deterministic kind/engine/ownership → capability key mapping.
//
// Lives at the Graph → IR boundary. The ApplicationGraph describes what the
// application needs (kind, engine, ownership); the Resolver translates that
// into AWS capability selection for DEPLOYZ_MANAGED resources.
// ---------------------------------------------------------------------------

/**
 * Resolve a Resource to its AWS capability key. Returns null for non-managed
 * resources or resources whose kind/engine combination has no known mapping.
 */
export function resolveResourceCapability(resource: Resource): string | null {
  if (resource.ownership !== 'DEPLOYZ_MANAGED') return null;

  const { kind, engine, id } = resource;

  if (kind === 'relational_database' && engine === 'postgres') {
    return CAPABILITY_KEYS.RDS_POSTGRES;
  }
  if (kind === 'relational_database' && engine === 'mysql') {
    return CAPABILITY_KEYS.RDS_MYSQL;
  }
  if (kind === 'cache' && engine === 'valkey') {
    return CAPABILITY_KEYS.ELASTICACHE_VALKEY;
  }
  if (kind === 'object_storage') {
    return CAPABILITY_KEYS.S3;
  }
  // Phase 5A: Standard queues only — any other queue engine (FIFO, a broker)
  // has no capability and stays unresolved.
  if (kind === 'queue' && engine === 'standard') {
    return CAPABILITY_KEYS.SQS;
  }
  if (kind === 'generic_service' && id === 'endpoint') {
    return CAPABILITY_KEYS.ALB;
  }

  return null;
}

/** Standard-queue defaults (Phase 5A): 4 days of retention, a 30 s visibility timeout. */
const QUEUE_DEFAULT_RETENTION_SECONDS = 345600;
const QUEUE_DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;
/** A dead-letter queue keeps failed messages for the SQS maximum, 14 days. */
const DEAD_LETTER_QUEUE_RETENTION_SECONDS = 1209600;

/**
 * Build capability-specific sizing/configuration for a resolved capability
 * key, using the given infrastructure size profile. `deadLetterTarget` marks
 * a queue some other queue or schedule dead-letters into.
 */
export function buildCapabilityConfiguration(
  capabilityKey: string,
  profile: InfrastructureSizeProfile,
  resource?: Resource,
  deadLetterTarget = false,
): Record<string, unknown> {
  if (capabilityKey === CAPABILITY_KEYS.SQS) {
    return {
      queueType: 'standard',
      messageRetentionSeconds:
        resource?.queue?.messageRetentionSeconds ??
        (deadLetterTarget ? DEAD_LETTER_QUEUE_RETENTION_SECONDS : QUEUE_DEFAULT_RETENTION_SECONDS),
      visibilityTimeoutSeconds: resource?.queue?.visibilityTimeoutSeconds ?? QUEUE_DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    };
  }
  if (capabilityKey === CAPABILITY_KEYS.RDS_POSTGRES) {
    return {
      engine: 'postgres',
      engineVersion: '16',
      instanceType: profile.database.instanceClass,
      storageGb: profile.database.storageGb,
      maxStorageGb: profile.database.maxStorageGb,
    };
  }
  if (capabilityKey === CAPABILITY_KEYS.RDS_MYSQL) {
    // Phase 4B: the engine version is pinned by Deployz (one constant, same
    // instance class / storage knobs as PostgreSQL).
    return {
      engine: 'mysql',
      engineVersion: '8.0',
      instanceType: profile.database.instanceClass,
      storageGb: profile.database.storageGb,
      maxStorageGb: profile.database.maxStorageGb,
      ...(resource?.urlScheme !== undefined ? { urlScheme: resource.urlScheme } : {}),
    };
  }
  if (capabilityKey === CAPABILITY_KEYS.ELASTICACHE_VALKEY) {
    return {
      engine: 'valkey',
      nodeType: profile.cache.nodeType,
      nodes: profile.cache.nodeCount,
    };
  }
  return {};
}
