'use client';

import { AlertCircle, ExternalLink, Lock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DOMAIN_STATUS_LABEL } from '@/lib/domains';
import type { FleetDeploymentDetail } from '@/lib/deployments';

/** The permanent Deployz address for a deployment.
 *
 * FALLBACK ONLY. The API sends the real default-HTTPS hostname as
 * `detail.defaultUrl`; this projection exists for stale cached payloads that
 * predate that field (the card always prefers `detail.defaultUrl` when the
 * API provides one). */
export function defaultDeployzUrl(deploymentId: string): string {
  return `https://d-${deploymentId}.deployz.dev`;
}

/** The customer-facing status label for a custom domain in the URL card. */
const CUSTOM_DOMAIN_STATUS_LABEL: Record<string, string> = {
  ...DOMAIN_STATUS_LABEL,
  pending: 'Waiting for domain setup',
  waiting_for_dns: 'Waiting for domain setup',
  configuring: 'Connecting',
  removing: 'Removing domain…',
};

interface DeploymentUrlCardProps {
  detail: FleetDeploymentDetail;
}

/**
 * The access block of the deployment-detail hero: the one place the page
 * shows the application's address, its Open/Copy actions, whether HTTPS
 * serves, and the custom domain. "HTTPS active" appears only when the
 * server's HTTPS component is READY — a successful HTTPS probe of the
 * address shown — never inferred from the URL scheme alone, and never while
 * the connector is not reporting or the latest HTTP probe failed.
 */
export function DeploymentUrlCard({ detail }: DeploymentUrlCardProps) {
  const custom = detail.customDomain;
  const defaultUrl = detail.defaultUrl ?? defaultDeployzUrl(detail.id);
  const appUrl = detail.appUrl ?? defaultUrl;
  const customActive = custom?.status === 'active';
  const url = customActive ? `https://${custom.hostname}` : appUrl;
  const httpsReady =
    detail.deploymentStatus.components.find((component) => component.key === 'https')?.status ===
    'READY';
  const { statusUpdatesUnavailable, health } = detail.deploymentStatus;
  const httpsActive =
    url.startsWith('https://') &&
    httpsReady &&
    !statusUpdatesUnavailable &&
    health.layers.http?.ok !== false;
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the link
      // itself still lets the user open or select the URL by hand.
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border px-3 py-3" data-testid="app-url">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-muted-foreground">Application URL</p>
            {httpsActive ? (
              <Badge variant="success">
                <Lock aria-hidden />
                HTTPS active
              </Badge>
            ) : null}
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 text-sm font-medium break-all text-primary underline-offset-4 hover:underline"
          >
            {url}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              Open application
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={copy}>
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t pt-3 text-sm">
        <CustomDomainLine detail={detail} />
        {customActive ? (
          <p className="text-xs text-muted-foreground">
            Also available at <span className="break-all">{defaultUrl}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CustomDomainLine({ detail }: { detail: FleetDeploymentDetail }) {
  const custom = detail.customDomain;
  const manageHref = `/install/${detail.installLinkId}`;
  const linkClass =
    'rounded-md font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50';

  if (!custom) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">Custom domain</span>
        <span className="text-muted-foreground">Not configured</span>
        <Link href={manageHref} className={linkClass}>
          Add custom domain
        </Link>
      </div>
    );
  }

  if (custom.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="custom-domain-error">
        <span className="text-muted-foreground">Custom domain</span>
        <span className="min-w-0 font-medium break-all">{custom.hostname}</span>
        <span className="inline-flex items-center gap-1 font-medium text-destructive">
          <AlertCircle aria-hidden className="size-4 shrink-0" />
          Needs attention
        </span>
        <Link href={manageHref} className={linkClass}>
          Manage custom domain
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">Custom domain</span>
      <span className="min-w-0 font-medium break-all">{custom.hostname}</span>
      <Badge variant={custom.status === 'active' ? 'success' : 'outline'}>
        {CUSTOM_DOMAIN_STATUS_LABEL[custom.status] ?? DOMAIN_STATUS_LABEL[custom.status]}
      </Badge>
      <Link href={manageHref} className={linkClass}>
        {custom.status === 'active' ? 'Manage custom domain' : 'Check custom domain'}
      </Link>
    </div>
  );
}
