import { DeployzIcon } from '@/components/deployz-brand';
import { DocsLink } from '@/components/docs-link';
import { DOCS } from '@/lib/docs-links';

// The fail-closed states shared by the tokenized /deploy page and its
// Security Details sub-page — one copy source so the wording never diverges
// between the two surfaces that carry the same link credential.

const INVALID_COPY: Record<string, { title: string; body: string }> = {
  invalid: {
    title: "This deployment link isn't valid",
    body: 'It may have been revoked, replaced, or entered incorrectly. Please request a new link from the software provider.',
  },
  revoked: {
    title: 'This deployment link is no longer valid',
    body: 'The software provider revoked this link. Please request a new link to deploy.',
  },
  expired: {
    title: 'This deployment link has expired',
    body: 'Please request a new link from the software provider.',
  },
  unavailable: {
    title: 'We couldn\u2019t load this deployment',
    body: 'Try again in a moment. If it keeps failing, contact the software provider.',
  },
};

export function DeployLinkInvalidState({ reason }: { reason: string }) {
  const copy = INVALID_COPY[reason] ?? INVALID_COPY.invalid!;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{copy.body}</p>
      <DocsLink href={DOCS.customerLinkDoesNotOpen}>If the link does not open</DocsLink>
      <PoweredBy />
    </div>
  );
}

export function PoweredBy() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-xs text-muted-foreground">
        Powered by{' '}
        <DeployzIcon className="mr-1 inline size-3 align-[-0.125em]" />
        Deployz
      </p>
      <DocsLink href={DOCS.customerGuide} className="text-xs">
        Customer guide
      </DocsLink>
    </div>
  );
}
