'use client';

import { ExternalLink } from 'lucide-react';

import { ConnectorUpdateDialog } from '@/components/connector-update-dialog';
import { DocsLink } from '@/components/docs-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import {
  CUSTOMER_ACTIVITY_LABELS,
  fetchInstallOverview,
  type ConnectorConnectivity,
  type InstallOverview,
} from '@/lib/customer-access';
import { DOCS } from '@/lib/docs-links';
import { installPlanRegionLabel } from '@/lib/install-plan';
import { useStatusPoll } from '@/lib/use-status-poll';

const CONNECTIVITY: Record<ConnectorConnectivity, { label: string; badge: 'success' | 'warning' | 'secondary' | 'outline' }> = {
  CONNECTED: { label: 'Connected', badge: 'success' },
  OFFLINE: { label: 'Offline', badge: 'warning' },
  NEVER_CONNECTED: { label: 'Not connected yet', badge: 'secondary' },
  UNKNOWN: { label: 'Unknown', badge: 'outline' },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** One line for the connector's update state, from the derived fields only. */
function connectorUpdateLine(connector: InstallOverview['connector']): {
  label: string;
  badge: 'success' | 'warning' | 'info' | 'destructive';
  detail: string | null;
} {
  switch (connector.stackState) {
    case 'UPDATING':
      return { label: 'Updating', badge: 'info', detail: 'AWS is updating the connector. This page shows the result.' };
    case 'ROLLED_BACK':
      if (connector.updateAvailable) {
        return {
          label: 'Update rolled back',
          badge: 'warning',
          detail: 'AWS rolled back the last update. The previous connector version still runs.',
        };
      }
      break;
    case 'FAILED':
      return {
        label: 'Update failed',
        badge: 'destructive',
        detail: 'The connector stack is in a failed state in AWS. Contact the publisher.',
      };
    default:
      break;
  }
  if (connector.upgradeRequired) {
    return { label: 'Update required', badge: 'warning', detail: 'The publisher cannot verify updates until you update the connector.' };
  }
  if (connector.updateAvailable) return { label: 'Update available', badge: 'warning', detail: null };
  return { label: 'Up to date', badge: 'success', detail: null };
}

// The customer page's lasting sections (docs/customer-access.md): the
// connector, where the deployment runs in AWS, recent activity and help.
// Connector loss never says the application is down.
export function CustomerDeploymentOverview({
  installLinkId,
  publisherName,
  removed,
}: {
  installLinkId: string;
  publisherName: string;
  removed: boolean;
}) {
  const poll = useStatusPoll<InstallOverview>({
    fetcher: () => fetchInstallOverview(installLinkId),
    intervalMs: 15_000,
    terminalIntervalMs: 60_000,
    isTerminal: (data) => data.connector.stackState !== 'UPDATING',
  });
  const overview = poll.data;
  if (!overview) return null;
  const { connector, aws } = overview;
  const connectivity = CONNECTIVITY[connector.connectivity];
  const update = connectorUpdateLine(connector);
  const regionLabel = installPlanRegionLabel(aws.region) ?? aws.region;
  const activity = overview.activity.filter((item) => CUSTOMER_ACTIVITY_LABELS[item.type]);

  return (
    <div className="flex flex-col gap-4" data-testid="customer-deployment-overview">
      {!removed && connector.connectivity === 'OFFLINE' ? (
        <Alert>
          <AlertTitle>Connector offline. The application status can be out of date.</AlertTitle>
          <AlertDescription>
            {connector.lastContactAt
              ? `Last contact ${formatTime(connector.lastContactAt)}. `
              : ''}
            The application can still run. Check that the connector stack is in your AWS account and
            not deleted, then contact {publisherName}.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {!removed ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deployz connector</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <dl className="flex flex-col">
                <Row label="Connection">
                  <Badge variant={connectivity.badge}>{connectivity.label}</Badge>
                </Row>
                <Row label="Last contact">{connector.lastContactAt ? formatTime(connector.lastContactAt) : 'No contact yet'}</Row>
                <Row label="Version">
                  <code className="font-mono text-xs">{connector.installedBuildId ?? 'Unknown'}</code>
                </Row>
                {connector.connectivity !== 'NEVER_CONNECTED' ? (
                  <Row label="Updates">
                    <Badge variant={update.badge}>{update.label}</Badge>
                  </Row>
                ) : null}
              </dl>
              {update.detail ? <p className="text-sm text-muted-foreground">{update.detail}</p> : null}
              {connector.updateAvailable && connector.stackState !== 'UPDATING' ? (
                <ConnectorUpdateDialog
                  region={aws.region}
                  stackName={connector.stackName}
                  accountId={aws.accountId}
                  installedBuildId={connector.installedBuildId ?? null}
                  publishedBuildId={connector.publishedBuildId ?? null}
                  updateUrl={connector.updateUrl}
                  templateUrl={connector.updateTemplateUrl}
                  required={connector.upgradeRequired}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">AWS location</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col">
              {aws.accountId ? (
                <Row label="AWS account">
                  <code className="font-mono text-xs">{aws.accountId}</code>
                </Row>
              ) : null}
              <Row label="Region">{regionLabel}</Row>
              {connector.stackName ? (
                <Row label="Connector stack">
                  <code className="break-all font-mono text-xs">{connector.stackName}</code>
                </Row>
              ) : null}
            </dl>
            <Button asChild variant="outline" className="w-fit">
              <a
                href={cloudFormationStacksUrl(aws.region, connector.stackName ?? undefined)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in AWS
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <ul className="flex flex-col divide-y" aria-label="Recent activity">
              {activity.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    {CUSTOMER_ACTIVITY_LABELS[item.type]}
                    {item.releaseVersion ? ` · ${item.releaseVersion}` : ''}
                  </span>
                  <time dateTime={item.occurredAt} className="text-muted-foreground">
                    {formatTime(item.occurredAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="customer-help" className="flex flex-col gap-2">
        <h2 id="customer-help" className="text-base font-semibold">
          Help
        </h2>
        <p className="text-sm text-muted-foreground">
          For questions about the application, its updates or this deployment, contact {publisherName}.
          The application, its data and the connector run in your AWS account.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <DocsLink href={DOCS.customerGuide}>Customer guide</DocsLink>
          <DocsLink href={DOCS.customerSecurity}>Security and permissions</DocsLink>
        </div>
      </section>
    </div>
  );
}
