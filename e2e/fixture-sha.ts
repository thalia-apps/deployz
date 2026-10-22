import { createHash } from 'node:crypto';

/** A full commit sha derived from a label: the release route accepts only hex commit shas. */
export function fixtureSha(label: string): string {
  return createHash('sha1').update(label).digest('hex');
}
