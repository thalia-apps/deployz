import type { VendorDeploymentStatus } from '@deployz/contracts';
import { RefreshCw } from 'lucide-react';

import { DocsLink } from '@/components/docs-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DOCS } from '@/lib/docs-links';

// A customer-approved update of the existing connector stack. It is not a
// reconnect: the credential stays, so nothing here asks for a new one.
export function ConnectorUpdateAlert({
  connector,
  customerName,
}: {
  connector: VendorDeploymentStatus['connector'];
  customerName: string;
}) {
  if (!connector.updateAvailable) return null;
  return (
    <Alert data-testid="connector-update">
      <RefreshCw aria-hidden />
      <AlertTitle>
        {connector.upgradeRequired
          ? 'Connector update required to verify releases'
          : 'Connector update available'}
      </AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
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
        {connector.updateUrl ? (
          <Button asChild variant="outline" size="sm" className="self-start">
            <a href={connector.updateUrl} target="_blank" rel="noopener noreferrer">
              Open connector stack in AWS
            </a>
          </Button>
        ) : null}
        <DocsLink href={DOCS.updateConnector}>How to update the connector</DocsLink>
      </AlertDescription>
    </Alert>
  );
}
