import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { CustomerInstallSections } from '@/components/customer-install-sections';
import { DocsLink } from '@/components/docs-link';
import { ExistingConnectorUpdate } from '@/components/existing-connector-update';
import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallLoadError } from '@/components/install-load-error';
import { InstallProgress } from '@/components/install-progress';
import { InstallRetryButton } from '@/components/install-retry-button';
import { InvitationTokenGate } from '@/components/invitation-token-gate';
import { LinkTokenGate } from '@/components/link-token-gate';
import { PublicInstallFlow } from '@/components/public-install-flow';
import { TechnicalDetails } from '@/components/technical-details';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RELAY_STUCK_GUIDANCE } from '@/lib/deployment-vocabulary';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import { DOCS } from '@/lib/docs-links';
import { fetchInstallData } from '@/lib/install-data';
import {
  installPlanRegionLabel,
  installPlanRetainedComponents,
  RETENTION_CHARGES_NOTE,
} from '@/lib/install-plan';
import { LINK_TOKEN_COOKIE } from '@/lib/link-token-cookie';
import { fetchPublicInstallData } from '@/lib/public-install-data';
import { publicInstallErrorMessage } from '@/lib/public-install-types';
import { fetchInstallStatusServer } from '@/lib/install-status';

// Rendered per request so the install data — including the Quick Create link
// the control plane builds for this deployment's region — is always fresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Install your app',
  // Unique private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// §44 install page: a vendor hands their customer this unique link. The
// customer needs NO Deployz account — they sign in to their OWN cloud account
// ("AWS auth happens at AWS"), and Deployz never sees or stores their
// credentials. Fetches the real §12/§44 data (application, publisher,
// customer, resources created); an unknown/invalid link gets an honest
// not-found state rather than fabricated content. Copy is §65 jargon-free
// at the top level; the Security Details page carries the technical truth.
export default async function InstallPage({
  params,
}: {
  params: Promise<{ installLinkId: string }>;
}) {
  const { installLinkId } = await params;
  const securityHref = `/install/${encodeURIComponent(installLinkId)}/security`;

  // Public install links expose an app-level review/confirm flow. Try that
  // surface first; a 404 means this id is a per-deployment install link, so
  // fall through to the existing flow. A 410 means the public link is known
  // but unavailable and must show its own error copy.
  const publicLookup = await fetchPublicInstallData(installLinkId);
  if (publicLookup?.status === 'ok') {
    return <PublicInstallFlow linkId={installLinkId} resolve={publicLookup.data} />;
  }
  if (publicLookup?.status === 'gone') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          This application cannot be installed
        </h1>
        <Alert variant="destructive">
          <AlertTitle>Install link unavailable</AlertTitle>
          <AlertDescription>{publicInstallErrorMessage(publicLookup.code)}</AlertDescription>
        </Alert>
        <DocsLink href={DOCS.customerLinkDoesNotOpen}>If the link does not open</DocsLink>
      </div>
    );
  }

  // The link secret reaches the server as a cookie: the browser moves it out
  // of the URL fragment (LinkTokenGate), so it never appears in a request URL.
  const token = (await cookies()).get(LINK_TOKEN_COOKIE)?.value;

  // Fetched in parallel: the status projection is a nice-to-have for the
  // first paint (a failed fetch just costs one extra client round trip —
  // see fetchInstallStatusServer), so it never blocks or fails the page.
  const [lookup, initialStatus] = await Promise.all([
    fetchInstallData(installLinkId, token),
    fetchInstallStatusServer(installLinkId),
  ]);

  // The control plane did not answer. That says nothing about the link, so
  // never show the expired or invalid copy for it.
  if (lookup.status === 'error' || (lookup.status === 'not_found' && publicLookup?.status === 'error')) {
    return <InstallLoadError href={`/install/${encodeURIComponent(installLinkId)}`} />;
  }

  // Invitation lifecycle: an expired or revoked link gets its own honest
  // customer state instead of the generic invalid-link copy.
  if (lookup.status === 'unavailable') {
    const revoked = lookup.code === 'INSTALL_LINK_REVOKED';
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {revoked ? 'This install link was revoked' : 'This install link has expired'}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">{lookup.message}</p>
      </div>
    );
  }

  if (lookup.status === 'not_found') {
    // Both server lookups failed. This is either a genuinely unknown id, or
    // a targeted invitation: those require the one-time token, which travels
    // as a URL fragment the server never sees. The client gate captures it
    // (or the sessionStorage copy a reload relies on), resolves privately,
    // and fails safe with this same state when no valid token exists.
    return <InvitationTokenGate installLinkId={installLinkId} />;
  }

  const data = lookup.data;
  const tokenGate = (
    <LinkTokenGate
      path={`/install/${installLinkId}`}
      current={token}
      fallback={
        <Alert>
          <AlertTitle>Open the full install link</AlertTitle>
          <AlertDescription>
            This page needs the whole link that {data.publisherName} sent. Open the link as you
            received it, or ask {data.publisherName} for a new link.
          </AlertDescription>
        </Alert>
      }
    />
  );

  // The customer pressed "Review setup in AWS" and the control plane is
  // waiting for the connector to enroll. Never a failure: past the staleness
  // window the page shows guidance and "Retry connection" instead. The
  // enrollment code is spent only when a connector actually connects, so this
  // state needs no "already used" warning.
  if (data.waitingForRelay) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.publisherName} is setting up inside your AWS account
          </p>
        </div>

        {/* Live progress; `preinstall` refreshes this server-rendered layout
            the moment the connector enrolls and the stage moves past
            WAITING_FOR_AWS. */}
        <InstallProgress
          installLinkId={installLinkId}
          deploymentId={data.deploymentId}
          initialStatus={initialStatus}
          quickCreateUrl={data.quickCreateUrl ?? data.existingStackUpdate?.consoleUrl ?? null}
          initialDomain={data.domain}
          routingTarget={data.routingTarget}
          preinstall
          notice={
            data.relayStuck ? (
              <section aria-labelledby="install-waiting" className="flex flex-col gap-3">
                <h2 id="install-waiting" className="text-base font-semibold">
                  Still connecting
                </h2>
                <div className="flex items-start gap-3">
                  <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                  <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>{RELAY_STUCK_GUIDANCE}</p>
                    <p>
                      Check the setup in AWS (link under Deployment details). If it failed or you
                      closed it, select Retry connection.
                    </p>
                  </div>
                </div>
                {data.credentialsWithheld ? (
                  tokenGate
                ) : (
                  <InstallRetryButton installLinkId={installLinkId} token={token} />
                )}
              </section>
            ) : null
          }
          details={
            <div className="flex flex-col gap-2">
              <ReferenceRow label="Expected stack name" value={data.bootstrapStackName} />
              <ReferenceRow label="Installation reference" value={installLinkId} />
              <a
                className="w-fit text-sm font-medium underline underline-offset-4"
                href={cloudFormationStacksUrl(data.region)}
                target="_blank"
                rel="noreferrer"
              >
                Open AWS CloudFormation
              </a>
            </div>
          }
        />

        <Button asChild variant="link" className="h-auto w-fit px-0">
          <Link href={securityHref}>Security details</Link>
        </Button>
      </div>
    );
  }

  // The enrollment code is single use. Once a connector has traded it,
  // running the setup again would fail at the point of no return — after the
  // customer has approved a stack in their own account.
  if (data.alreadyInstalled) {
    const removed = data.deploymentState === 'DELETING' || data.deploymentState === 'DELETED';
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.applicationName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {removed ? `Published by ${data.publisherName}` : `Deployed by ${data.publisherName}`}
          </p>
        </div>

        {removed ? (
          <RemovedDeployment
            deleting={data.deploymentState === 'DELETING'}
            publisherName={data.publisherName}
            retainedNames={installPlanRetainedComponents(data.plan).map((component) => component.name)}
            region={data.region}
            connectorStackName={data.bootstrapStackName}
            retainedDataDeleted={data.retainedDataDeleted === true}
          />
        ) : (
          // CONNECTING through READY, plus a terminal FAILED, all live here:
          // InstallProgress polls the server-derived stage and — once the
          // stage reaches VERIFYING/READY — also renders the Access section
          // and the custom-domain card itself, so this branch doesn't need
          // its own stage logic.
          <InstallProgress
            installLinkId={installLinkId}
            deploymentId={data.deploymentId}
            initialStatus={initialStatus}
            quickCreateUrl={data.quickCreateUrl ?? data.existingStackUpdate?.consoleUrl ?? null}
            initialDomain={data.domain}
            routingTarget={data.routingTarget}
          />
        )}

        {/* The enrollment code is single-use and is spent as soon as the
            connector trades it — long before the install finishes. This copy
            stays out of the primary flow: it must NOT look like a failure
            note, only a de-emphasized footnote about the link itself. */}
        <p className="text-xs text-muted-foreground" data-testid="consumed-link-notice">
          This install link has been used. Another installation needs a new link.
        </p>
      </div>
    );
  }

  const regionLabel = installPlanRegionLabel(data.region);
  const expiryLabel = data.installLinkExpiresAt
    ? new Date(data.installLinkExpiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
    : null;

  // Not launched yet: the one review surface (ux-guidelines §1) — what, where,
  // cost, what is created, retained data — then the AWS connection step with
  // its single primary action, and the access detail behind one disclosure.
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Deploy {data.applicationName} to your AWS account
        </h1>
        <p className="text-sm text-muted-foreground">Published by {data.publisherName}</p>
        <DocsLink href={DOCS.customerInstall}>How the installation works</DocsLink>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-8 py-2">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">AWS Region</dt>
              <dd className="mt-1 text-sm font-medium">{regionLabel ?? data.region}</dd>
            </div>
            {data.releaseVersion ? (
              <div>
                <dt className="text-xs text-muted-foreground">Release</dt>
                <dd className="mt-1 text-sm font-medium">{data.releaseVersion}</dd>
              </div>
            ) : null}
            {expiryLabel ? (
              <div>
                <dt className="text-xs text-muted-foreground">Invitation expires</dt>
                <dd className="mt-1 text-sm font-medium">{expiryLabel}</dd>
              </div>
            ) : null}
          </dl>

          <CustomerInstallSections plan={data.plan} />

          {data.credentialsWithheld ? (
            tokenGate
          ) : data.existingStackUpdate ? (
            <ExistingConnectorUpdate installLinkId={installLinkId} update={data.existingStackUpdate} />
          ) : (
          <section aria-labelledby="connect-aws" className="flex flex-col gap-2">
            <h2 id="connect-aws" className="sr-only">
              Connect AWS account
            </h2>
            {data.quickCreateUrl ? (
              <InstallLaunchButton
                installLinkId={installLinkId}
                quickCreateUrl={data.quickCreateUrl}
                label="Connect AWS account"
                className="w-full"
              />
            ) : (
              <>
                <Button size="lg" className="w-full" disabled>
                  Connect AWS account
                </Button>
                <p className="text-sm text-muted-foreground">
                  {data.publisherName} hasn&apos;t published a setup template yet. Contact them for a
                  working link.
                </p>
              </>
            )}
            <p className="text-center text-xs text-muted-foreground">
              Opens the AWS console in a new tab. Nothing is created until you approve it there. No
              Deployz account needed.
            </p>
          </section>
          )}

          <TechnicalDetails className="border-t pt-4">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
              <li>In the AWS console, check the AWS account and Region.</li>
              <li>Create the Deployz connector stack.</li>
              <li>Deployz creates the infrastructure and starts the application. Progress shows here.</li>
            </ol>
            <p className="text-sm text-muted-foreground">
              Requires an AWS identity that can create CloudFormation stacks and the resources listed
              above.
            </p>
            <Button asChild variant="link" size="sm" className="h-auto w-fit px-0">
              <Link href={securityHref}>Security &amp; permissions details</Link>
            </Button>
            <ReferenceRow label="Installation reference" value={installLinkId} />
          </TechnicalDetails>
        </CardContent>
      </Card>
    </div>
  );
}

function ReferenceRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {label}:{' '}
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{value}</code>
    </p>
  );
}

/**
 * The customer's removed page (ux-guidelines §7). After a purge the relay
 * verified, only the connector stack remains. Otherwise it names what CAN
 * remain, from the deployment's plan, and never claims a cleanup Deployz did
 * not verify: a forced or failed removal looks like a normal one here
 * (UX-BACKEND-001).
 */
function RemovedDeployment({
  deleting,
  publisherName,
  retainedNames,
  region,
  connectorStackName,
  retainedDataDeleted,
}: {
  deleting: boolean;
  publisherName: string;
  retainedNames: string[];
  region: string;
  connectorStackName: string | null;
  retainedDataDeleted: boolean;
}) {
  if (deleting) {
    return (
      <section aria-labelledby="deployment-removed" className="flex flex-col gap-3">
        <h2 id="deployment-removed" className="text-base font-semibold">
          Removing deployment
        </h2>
        <p className="text-sm text-muted-foreground">
          {publisherName} is removing this deployment from your AWS account. Contact them if
          unexpected.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="deployment-removed" className="flex flex-col gap-3">
      <h2 id="deployment-removed" className="text-base font-semibold">
        Deployment removed
      </h2>
      <p className="text-sm text-muted-foreground">
        {publisherName} removed this deployment. The application no longer runs. Contact them if
        unexpected.
      </p>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">
          {retainedDataDeleted ? 'What remains in your AWS account' : 'What can remain in your AWS account'}
        </h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {(retainedDataDeleted ? [] : retainedNames).map((name) => (
            <li key={name}>{name}</li>
          ))}
          <li>
            The Deployz connector
            {connectorStackName ? (
              <>
                {' '}
                (stack{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {connectorStackName}
                </code>
                )
              </>
            ) : null}
          </li>
        </ul>
      </div>
      {retainedDataDeleted ? (
        <p className="text-sm text-muted-foreground">
          {publisherName} deleted the data that was kept after removal. To finish, delete the
          connector stack in AWS CloudFormation.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{RETENTION_CHARGES_NOTE}</p>
          <p className="text-sm text-muted-foreground">
            To delete them, ask {publisherName} or use the AWS console. Keep the connector stack
            until the retained data is deleted, because deletion runs through it. Then delete the
            connector stack.
          </p>
        </>
      )}
      <DocsLink href={DOCS.customerRemove}>How to delete what remains</DocsLink>
      <Button asChild variant="outline" className="w-fit">
        <a
          href={cloudFormationStacksUrl(region, connectorStackName ?? undefined)}
          target="_blank"
          rel="noreferrer"
        >
          Open AWS CloudFormation
        </a>
      </Button>
    </section>
  );
}
