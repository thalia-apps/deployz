import type { VendorDeploymentStatus } from '@deployz/contracts';
import { CircleAlert, LoaderCircle, RefreshCw, Undo2 } from 'lucide-react';

import { DocsLink } from '@/components/docs-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DOCS } from '@/lib/docs-links';

// A customer-approved update of the existing connector stack. It is not a
// reconnect: the credential stays, so nothing here asks for a new one.
export function ConnectorUpdateAlert({
  connector,
  customerName,
  offline = false,
}: {
  connector: VendorDeploymentStatus['connector'];
  customerName: string;
  /** An offline connector cannot be updated; the reconnect path comes first. */
  offline?: boolean;
}) {
  if (connector.stackState === 'UPDATING') {
    return (
      <Alert data-testid="connector-update">
        <LoaderCircle aria-hidden className="animate-spin" />
        <AlertTitle>Connector update in progress</AlertTitle>
        <AlertDescription>
          The connector stack in {customerName}&apos;s AWS account is updating. New operations start after
          the update completes. The application continues to run.
        </AlertDescription>
      </Alert>
    );
  }
  if (connector.stackState === 'FAILED') {
    return (
      <Alert variant="destructive" data-testid="connector-update">
        <CircleAlert aria-hidden />
        <AlertTitle>Connector update failed</AlertTitle>
        <AlertDescription className="flex min-w-0 flex-col gap-2">
          <p>
            AWS could not update or restore the connector stack in {customerName}&apos;s AWS account.{' '}
            {customerName} must open the connector stack in AWS and look at its events.
          </p>
          <ConnectorStackLink connector={connector} />
          <DocsLink href={DOCS.updateConnector}>How to update the connector</DocsLink>
        </AlertDescription>
      </Alert>
    );
  }
  if (!connector.updateAvailable || offline) return null;
  const rolledBack = connector.stackState === 'ROLLED_BACK';
  return (
    <Alert data-testid="connector-update">
      {rolledBack ? <Undo2 aria-hidden /> : <RefreshCw aria-hidden />}
      <AlertTitle>
        {rolledBack
          ? 'Connector update rolled back'
          : connector.upgradeRequired
            ? 'Connector update required to verify releases'
            : 'Connector update available'}
      </AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
        {rolledBack ? (
          <p>
            AWS restored the previous connector version. The application continues to run. {customerName} can
            try the update again.
          </p>
        ) : null}
        <p>
          {customerName} updates the connector in their AWS account. Open the connector stack, select
          Update, then Replace existing template
          {connector.updateTemplateUrl ? ' and enter the template URL below' : ''}. Keep all existing
          parameter values (Use existing value), especially RelayCredential.
        </p>
        {connector.updateTemplateUrl ? (
          <code className="block overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
            {connector.updateTemplateUrl}
          </code>
        ) : null}
        <ConnectorStackLink connector={connector} />
        <DocsLink href={DOCS.updateConnector}>How to update the connector</DocsLink>
      </AlertDescription>
    </Alert>
  );
}

function ConnectorStackLink({ connector }: { connector: VendorDeploymentStatus['connector'] }) {
  if (!connector.updateUrl) return null;
  return (
    <Button asChild variant="outline" size="sm" className="self-start">
      <a href={connector.updateUrl} target="_blank" rel="noopener noreferrer">
        Open connector stack in AWS
      </a>
    </Button>
  );
}
