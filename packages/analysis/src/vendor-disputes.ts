/**
 * Vendor disputes of blocking findings ("not used in production"). An answer
 * applies only while the rules find the same evidence: it names the finding
 * id and the finding's evidence text. A changed reason makes it stale. A
 * finding that is not on the disputable list never applies.
 */
import { isDisputableFinding, type VendorDismissedRejection } from '@deployz/contracts';

import type { AnalysisResult, ResourceOverrides } from './analyser.js';
import { localFileStorageEvidence, rejectionFindingId } from './readiness-report.js';

export interface VendorResourceOverrides {
  readonly overrides: ResourceOverrides;
  readonly applied: boolean;
  /** Indexes of the entries that matched the rules evidence. */
  readonly matched: ReadonlySet<number>;
}

/** The overrides that the vendor's still-valid answers give for a rules-only analysis. */
export function vendorResourceOverrides(
  rules: AnalysisResult,
  entries: readonly VendorDismissedRejection[],
): VendorResourceOverrides {
  const dismissedRejections: string[] = [];
  let localFilesystem: false | undefined;
  const matched = new Set<number>();
  const localFs = rules.findings.find((finding) => finding.detector === 'local-filesystem' && finding.detected);

  entries.forEach((entry, index) => {
    if (!isDisputableFinding(entry.findingId)) return;
    if (entry.findingId === 'local-file-storage') {
      if (localFs && localFileStorageEvidence(localFs) === entry.reason) {
        localFilesystem = false;
        matched.add(index);
      }
      return;
    }
    const rejection = rules.rejections.find(
      (candidate) =>
        candidate.detected && candidate.reason === entry.reason && rejectionFindingId(candidate.dependency) === entry.findingId,
    );
    if (!rejection) return;
    dismissedRejections.push(rejection.reason);
    matched.add(index);
  });

  const overrides: ResourceOverrides = {
    ...(dismissedRejections.length > 0 ? { dismissedRejections } : {}),
    ...(localFilesystem === false ? { localFilesystem } : {}),
  };
  return { overrides, applied: matched.size > 0, matched };
}

/** Both sets of overrides: dismissed rejections are joined, every other value of `next` wins. */
export function combineOverrides(base: ResourceOverrides | undefined, next: ResourceOverrides): ResourceOverrides {
  if (!base) return next;
  const dismissed = [...(base.dismissedRejections ?? []), ...(next.dismissedRejections ?? [])];
  const combined: ResourceOverrides = { ...base, ...next };
  return dismissed.length > 0 ? { ...combined, dismissedRejections: [...new Set(dismissed)] } : combined;
}
