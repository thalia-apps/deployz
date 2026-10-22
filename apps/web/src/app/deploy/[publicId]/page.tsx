import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { CustomerInstallSections } from '@/components/customer-install-sections';
import { DeployLinkInvalidState, PoweredBy } from '@/components/deploy-link-invalid-state';
import { ExistingConnectorUpdate } from '@/components/existing-connector-update';
import { InstallLaunchButton } from '@/components/install-launch-button';
import { InstallProgress } from '@/components/install-progress';
import { InstallRetryButton } from '@/components/install-retry-button';
import { LinkTokenGate } from '@/components/link-token-gate';
import { Button } from '@/components/ui/button';
import {
  fetchDeployLinkData,
  fetchDeployLinkStatusServer,
} from '@/lib/deploy-link-flow';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import { RELAY_STUCK_GUIDANCE } from '@/lib/deployment-vocabulary';
import { installPlanRegionLabel } from '@/lib/install-plan';
import { LINK_TOKEN_COOKIE } from '@/lib/link-token-cookie';

// Rendered per request so the resolve — including the Quick Create link the
// control plane builds for this deployment's region — is always fresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Deploy to AWS',
  // Tokenized private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// The hosted customer deploy page: a vendor sends their customer a Deploy
// Link, the customer opens it here, connects their own AWS account through
// the SAME flow as the install page, and watches the deployment come up. The
// token in the URL is the only credential — it authorizes exactly this one
// deployment flow and never becomes a session. It travels in the URL
// fragment; LinkTokenGate moves it into a cookie, so it never appears in a
// request URL. Reuse rule: the review, AWS
// connection, progress, domain and retry experiences are the install page's,
// with resolve/launch/retry/status calls re-keyed to the deploy link.
export default async function DeployPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  const token = (await cookies()).get(LINK_TOKEN_COOKIE)?.value;

  // A first visit has no cookie yet: the gate takes the secret from the
  // fragment and refreshes. The invalid copy shows only when there is none.
  if (!token) {
    return (
      <LinkTokenGate
        path={`/deploy/${publicId}`}
        fallback={<DeployLinkInvalidState reason="invalid" />}
      />
    );
  }

  // Fetched in parallel: the status projection is a nice-to-have for the
  // first paint (a failed fetch just costs one extra client round trip), so
  // it never blocks or fails the page.
  const [result, initialStatus] = await Promise.all([
    fetchDeployLinkData(publicId, token),
    fetchDeployLinkStatusServer(publicId, token),
  ]);

  if (!result.ok) {
    // A stale cookie from an earlier link: a new fragment still replaces it.
    return (
      <>
        <DeployLinkInvalidState reason={result.reason} />
        <LinkTokenGate path={`/deploy/${publicId}`} current={token} fallback={null} />
      </>
    );
  }
  const data = result.data;
  const deployLink = { publicId, token };
  const securityHref = `/deploy/${encodeURIComponent(publicId)}/security`;
  const securityLink = (
    <Button asChild variant="link" className="h-auto w-fit px-0">
      <Link href={securityHref}>Security details</Link>
    </Button>
  );

  // The customer pressed "Review setup in AWS" and the control plane is
  // waiting for the connector to enroll. Never a failure: past the staleness
  // window the page shows guidance and "Retry connection" instead.
  if (data.waitingForRelay) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.application.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This application is setting up inside your AWS account
          </p>
        </div>

        <InstallProgress
          installLinkId={publicId}
          deploymentId=""
          initialStatus={initialStatus}
          quickCreateUrl={data.quickCreateUrl ?? data.existingStackUpdate?.consoleUrl ?? null}
          initialDomain={data.domain}
          routingTarget={data.routingTarget}
          plan={data.plan}
          preinstall
          deployLink={deployLink}
          notice={
            data.relayStuck ? (
              <section aria-labelledby="deploy-waiting" className="flex flex-col gap-3">
                <h2 id="deploy-waiting" className="text-base font-semibold">
                  Still connecting
                </h2>
                <div className="flex items-start gap-3">
                  <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{RELAY_STUCK_GUIDANCE}</p>
                </div>
                <InstallRetryButton installLinkId={publicId} deployLink={deployLink} />
              </section>
            ) : null
          }
          details={
            <div className="flex flex-col gap-2">
              {data.bootstrapStackName ? (
                <p className="text-xs text-muted-foreground">
                  Expected stack name:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {data.bootstrapStackName}
                  </code>
                </p>
              ) : null}
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

        {securityLink}

        <PoweredBy />
      </div>
    );
  }

  // Not launched yet: the same review as the install page, then the AWS
  // connection step with its single primary action. Double submits cannot
  // create duplicates — the deployment already exists; the launch only flips
  // it into its waiting state, and reopening the link resumes it.
  if (data.deploymentState === 'NOT_INSTALLED') {
    const regionLabel = installPlanRegionLabel(data.region);

    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Deploy {data.application.name} to your AWS account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">Region: {regionLabel ?? data.region}</p>
        </div>

        <CustomerInstallSections
          plan={data.plan}
          securityHref={securityHref}
        />

        {data.existingStackUpdate ? (
          <ExistingConnectorUpdate
            installLinkId={publicId}
            update={data.existingStackUpdate}
            deployLink={deployLink}
          />
        ) : (
        <section aria-labelledby="connect-aws" className="flex flex-col gap-3">
          <h2 id="connect-aws" className="text-base font-semibold">
            Connect AWS account
          </h2>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
            <li>Select Connect AWS account. The AWS console opens in a new tab.</li>
            <li>Check the AWS account and Region, then create the Deployz connector stack.</li>
            <li>Deployz creates the infrastructure and starts the application. Progress shows here.</li>
          </ol>
          {data.quickCreateUrl ? (
            <InstallLaunchButton
              installLinkId={publicId}
              quickCreateUrl={data.quickCreateUrl}
              deployLink={deployLink}
              label="Connect AWS account"
            />
          ) : (
            <>
              <Button size="lg" className="w-fit" disabled>
                Connect AWS account
              </Button>
              <p className="text-sm text-muted-foreground">
                No setup template for this Region yet. Ask the software provider for a new link.
              </p>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Requires an AWS identity that can create CloudFormation stacks and the resources above.
            No Deployz account needed.
          </p>
        </section>
        )}

        <PoweredBy />
      </div>
    );
  }

  // Launched and past the waiting state: CONNECTING through READY, plus a
  // terminal FAILED, all live in the same progress view the install page
  // uses. The link stays usable to resume — reopening it lands here.
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.application.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This application runs inside your AWS account
        </p>
      </div>

      <InstallProgress
        installLinkId={publicId}
        deploymentId=""
        initialStatus={initialStatus}
        quickCreateUrl={data.quickCreateUrl ?? data.existingStackUpdate?.consoleUrl ?? null}
        initialDomain={data.domain}
        routingTarget={data.routingTarget}
        plan={data.plan}
        deployLink={deployLink}
      />

      {securityLink}

      <PoweredBy />
    </div>
  );
}
