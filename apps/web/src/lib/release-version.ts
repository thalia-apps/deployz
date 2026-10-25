// Release versions are vendor-chosen strings. The UI shows a numeric version
// with a "v" prefix, but a vendor who already names a release "v1.3.0" must
// not see "vv1.3.0", and a commit-named release ("8b69e5d109cb") is no
// version number at all.
export function formatReleaseVersion(version: string): string {
  return /^\d+(\.\d+)*([-+].*)?$/.test(version) ? `v${version}` : version;
}

/**
 * The "Running release" value. A release is shown as running only once relay
 * evidence confirms it; until then it is the last confirmed one, still being
 * verified. While the connector is not reporting (`live` false) nothing is
 * being verified, so a release is only ever the last confirmed one.
 */
export function runningReleaseDisplay(
  version: string | null,
  confirmed: boolean,
  live: boolean,
): { text: string; note: string | null } {
  if (version === null) return { text: 'Not deployed yet', note: null };
  if (confirmed && live) return { text: formatReleaseVersion(version), note: null };
  return { text: `Last confirmed ${formatReleaseVersion(version)}`, note: live ? 'Verifying…' : null };
}
