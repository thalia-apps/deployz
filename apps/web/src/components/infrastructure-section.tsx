'use client';

import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { DeploymentActionError, retryDefaultHttps } from '@/lib/deployments';
import type { InfrastructureComponent, InfrastructureResponse } from '@/lib/deployments';
import {
  INFRASTRUCTURE_COMPONENT_NAME,
  INFRASTRUCTURE_COMPONENT_PURPOSE,
  INFRASTRUCTURE_LIFECYCLE_LABEL,
  INFRASTRUCTURE_STATUS_BADGE,
  INFRASTRUCTURE_SUMMARY_STATUS_BADGE,
  INFRASTRUCTURE_SUMMARY_STATUS_LABEL,
  infrastructureComponentStatusLabel,
  operationalComponentStatus,
  operationalSummaryStatus,
  type PurgeProgress,
  visibleResources,
} from '@/lib/deployment-vocabulary';

interface InfrastructureSectionProps {
  data: InfrastructureResponse | null;
  deploymentId: string;
  deploymentState?: string;
  purge?: PurgeProgress;
  /** The deployment's custom domain is in its terminal error state. */
  customDomainFailed?: boolean;
}

export function InfrastructureSection({
  data,
  deploymentId,
  deploymentState,
  purge = null,
  customDomainFailed = false,
}: InfrastructureSectionProps) {
  if (data === null) {
    return <InfrastructureSkeleton />;
  }

  const headerTitle = deploymentState === 'DELETED' ? 'Deployment removed' : `AWS · ${data.region}`;
  const summaryStatus = operationalSummaryStatus(data, deploymentState ?? '', purge);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{headerTitle}</CardTitle>
            <CardDescription>
              {data.summary.componentCount} component{data.summary.componentCount === 1 ? '' : 's'}
            </CardDescription>
          </div>
          {data.stackStatus ? (
            <span className="text-xs text-muted-foreground">
              Stack status: {data.stackStatus}
            </span>
          ) : null}
        </div>
        <Badge variant={INFRASTRUCTURE_SUMMARY_STATUS_BADGE[summaryStatus]}>
          {INFRASTRUCTURE_SUMMARY_STATUS_LABEL[summaryStatus]}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.snapshotState === 'none' ? (
          // A failed install never created a stack's worth of resources, so
          // the "will appear as resources are created" line would be a lie —
          // say what actually happened instead (the progress card and the
          // activity feed above carry the failure itself).
          <p className="text-sm text-muted-foreground">
            {deploymentState === 'FAILED'
              ? 'No resources were created before the failure.'
              : 'Details appear as AWS resources are created.'}
          </p>
        ) : (
          <>
            {data.connectionState === 'disconnected' ? (
              <Alert>
                <AlertTriangle aria-hidden />
                <AlertTitle>AWS connection unavailable</AlertTitle>
                <AlertDescription>
                  Showing infrastructure last verified at{' '}
                  {data.disconnectWarning?.lastVerifiedAt
                    ? new Date(data.disconnectWarning.lastVerifiedAt).toLocaleString('en-US')
                    : 'an unknown time'}
                  .
                </AlertDescription>
              </Alert>
            ) : null}
            <ul className="flex flex-col gap-3">
              {data.components.map((component) => (
                <ComponentRow
                  key={component.kind}
                  component={component}
                  deploymentId={deploymentId}
                  deploymentState={deploymentState ?? ''}
                  purge={purge}
                  customDomainFailed={customDomainFailed}
                />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ComponentRow({
  component,
  deploymentId,
  deploymentState,
  purge,
  customDomainFailed,
}: {
  component: InfrastructureComponent;
  deploymentId: string;
  deploymentState: string;
  purge: PurgeProgress;
  customDomainFailed: boolean;
}) {
  const status = operationalComponentStatus(component, deploymentState, purge);
  const resources = visibleResources(component.resources, deploymentState);
  const failingReason = firstFailingReason(component);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The API folds a custom domain's error into the endpoint's HTTPS state.
  // Retrying the default HTTPS setup cannot repair that, so the action is
  // offered only when the failure is not the custom domain's.
  const needsHttpsRetry =
    component.kind === 'endpoint' && component.defaultHttpsStatus === 'ERROR' && !customDomainFailed;

  async function onRetryHttps(): Promise<void> {
    setPending(true);
    setNotice(null);
    try {
      await retryDefaultHttps(deploymentId);
      toast.success('HTTPS setup retry requested');
    } catch (caught) {
      if (caught instanceof DeploymentActionError && caught.code === 'NOT_IN_ERROR') {
        setNotice('HTTPS setup is no longer in a failed state.');
      } else {
        setNotice("Couldn't retry HTTPS setup. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            {INFRASTRUCTURE_COMPONENT_NAME[component.kind] ?? component.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {INFRASTRUCTURE_COMPONENT_PURPOSE[component.kind] ?? component.purpose}
          </span>
        </div>
        <Badge variant={INFRASTRUCTURE_STATUS_BADGE[status]}>
          {infrastructureComponentStatusLabel({ ...component, status }, deploymentState, purge)}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{component.awsService}</span>
        <span>{component.region}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {INFRASTRUCTURE_LIFECYCLE_LABEL[component.lifecycle]}
      </p>
      {component.status === 'failed' || component.httpsState === 'FAILED' ? (
        <div className="flex flex-col gap-2">
          {failingReason ? (
            <p className="text-xs text-destructive">{failingReason}</p>
          ) : null}
          {needsHttpsRetry ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              loading={pending}
              loadingText="Retrying HTTPS setup…"
              onClick={() => void onRetryHttps()}
            >
              Retry HTTPS setup
            </Button>
          ) : null}
          {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        </div>
      ) : null}
      {resources.length > 0 ? <TechnicalDisclosure resources={resources} /> : null}
    </li>
  );
}

function TechnicalDisclosure({ resources }: { resources: InfrastructureComponent['resources'] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground">
        View {resources.length} technical AWS resource
        {resources.length === 1 ? '' : 's'}
        <ChevronDown
          aria-hidden
          className="size-4 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col gap-2">
          {resources.map((resource) => (
            <li
              key={`${resource.logicalId}-${resource.physicalId ?? ''}`}
              className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{resource.logicalId}</span>
                <Badge variant="secondary">{resource.status}</Badge>
              </div>
              <span className="text-muted-foreground">{resource.type}</span>
              {resource.physicalId ? (
                <span className="break-all text-muted-foreground">{resource.physicalId}</span>
              ) : null}
              {resource.statusReason ? (
                <span className="text-destructive">{resource.statusReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InfrastructureSkeleton() {
  return (
    <Card aria-busy="true">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

function firstFailingReason(component: InfrastructureComponent): string | null {
  const failing = component.resources.find((resource) => resource.statusReason !== null);
  return failing?.statusReason ?? null;
}
