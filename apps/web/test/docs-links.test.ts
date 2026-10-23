import { describe, expect, it } from 'vitest';

import { DOCS, DOCS_URL, failureCodeDocsUrl } from '../src/lib/docs-links';

describe('failureCodeDocsUrl', () => {
  it('links a documented code to its own failure-codes entry', () => {
    expect(failureCodeDocsUrl('AWS_SCP_BLOCKED')).toBe(
      'https://deployz.dev/docs/reference/failure-codes#aws_scp_blocked',
    );
  });

  it('sends UNKNOWN and codes outside the vocabulary to the troubleshooting overview', () => {
    expect(failureCodeDocsUrl('UNKNOWN')).toBe(DOCS.troubleshooting);
    expect(failureCodeDocsUrl('RDS_UNAVAILABLE')).toBe(DOCS.troubleshooting);
  });
});

describe('DOCS', () => {
  it('keeps every link on the documentation site', () => {
    for (const url of Object.values(DOCS)) {
      expect(url.startsWith(DOCS_URL)).toBe(true);
    }
  });
});
