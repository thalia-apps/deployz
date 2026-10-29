import { z } from 'zod';

/**
 * Blocking readiness findings that a vendor can mark as "not used in
 * production". A wrong answer only fails the vendor's own TEST deployment:
 * every other gate still runs. Hard constraints (GPU, architecture, no
 * buildable Dockerfile, a .git copy) are not on the list.
 */
export const DISPUTABLE_FINDING_IDS = [
  'unsupported-database-mongo',
  'unsupported-database-elasticsearch',
  'unsupported-database-other',
  'unsupported-database-sqlite',
  'unsupported-database-mariadb',
  'unsupported-redis-setup',
  'unsupported-message-queue',
  'unsupported-multi-service',
  'unconfirmed-declared-service',
  'unsupported-persistent-volume',
  'local-file-storage',
] as const;

const DISPUTABLE = new Set<string>(DISPUTABLE_FINDING_IDS);

export function isDisputableFinding(findingId: string): boolean {
  return DISPUTABLE.has(findingId);
}

/** Findings whose dismissal can lose files that the application writes. */
export const STORAGE_DISPUTE_FINDING_IDS: ReadonlySet<string> = new Set([
  'unsupported-persistent-volume',
  'local-file-storage',
]);

export const MAX_VENDOR_DISMISSED_REJECTIONS = 20;

/**
 * One vendor answer, stored on `detected_metadata.vendorDismissedRejections`.
 * `reason` is the finding's evidence text when the vendor answered: the
 * answer applies only while the analysis finds the same evidence.
 */
export const vendorDismissedRejectionSchema = z
  .object({
    findingId: z.string().min(1),
    reason: z.string().min(1).max(2000),
    dismissedAt: z.string(),
    dismissedBy: z.string(),
    /** True when the last analysis found no matching evidence. */
    stale: z.boolean().optional(),
  })
  .strict();
export type VendorDismissedRejection = z.infer<typeof vendorDismissedRejectionSchema>;

/** The valid entries of `detected_metadata.vendorDismissedRejections`; anything else is dropped. */
export function readVendorDismissedRejections(metadata: Record<string, unknown> | null | undefined): VendorDismissedRejection[] {
  const raw = metadata?.['vendorDismissedRejections'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = vendorDismissedRejectionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
