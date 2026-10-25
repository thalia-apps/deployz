'use client';

import { ArrowRight, CircleAlert, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { RepositoryPicker } from '@/components/repository-picker';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications, type Application } from '@/lib/applications';
import { applicationListBadge, STATUS_UNKNOWN_BADGE, type ApplicationPresentation } from '@/lib/application-state';
import { fetchDeployments } from '@/lib/deployments';
import { DOCS } from '@/lib/docs-links';
import { fetchReadiness } from '@/lib/readiness';
import { mapWithConcurrency } from '@/lib/map-with-concurrency';

// Where the GitHub App setup callback sends the vendor back to
// (`?github=failed|missing_installation`) when no installation was linked.
const GITHUB_CONNECT_FAILURES: Record<string, string> = {
  failed:
    'Deployz could not link the GitHub installation to this organization. Connect GitHub again from Add application. An installation that another Deployz organization already uses cannot be linked here.',
  missing_installation: 'GitHub did not return an installation. Connect GitHub again from Add application.',
};

// The API's Lambda account quota is small (10 concurrent executions), so the
// per-application readiness reads go a few at a time.
const READINESS_FETCH_CONCURRENCY = 4;

type AppsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; applications: Application[] };

// The org's applications — one per repository it deploys to customers. An org
// with none yet is mid-onboarding (§42 steps 1-2), so the repository picker
// sits right here: there is nothing to add *to* and no list for it to crowd
// out. Once applications exist the list is the subject of the page and every
// further addition goes through /dashboard/applications/new.
export default function ApplicationsPage() {
  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [githubFailure, setGithubFailure] = useState<string | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('github');
    setGithubFailure(result !== null ? (GITHUB_CONNECT_FAILURES[result] ?? null) : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAppsState({ status: 'loading' });
    async function loadApps(): Promise<void> {
      try {
        const applications = await fetchApplications();
        if (cancelled) return;
        setAppsState({ status: 'loaded', applications });
      } catch {
        if (!cancelled) {
          setAppsState({
            status: 'error',
            message: "Couldn't load applications. Try again.",
          });
        }
      }
    }
    void loadApps();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const hasApplications = appsState.status === 'loaded' && appsState.applications.length > 0;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
        {hasApplications ? (
          <Button asChild data-testid="add-application-button">
            <Link href="/dashboard/applications/new">
              <Plus aria-hidden />
              Add application
            </Link>
          </Button>
        ) : null}
      </div>

      {githubFailure ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>GitHub was not connected</AlertTitle>
          <AlertDescription>{githubFailure}</AlertDescription>
        </Alert>
      ) : null}

      {appsState.status === 'loading' ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {appsState.status === 'error' ? (
        <section
          aria-labelledby="applications-error"
          className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="applications-error" className="text-lg font-semibold">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground">{appsState.message}</p>
          <Button
            variant="outline"
            data-testid="applications-retry"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </Button>
        </section>
      ) : null}

      {hasApplications ? <ApplicationList applications={appsState.applications} /> : null}

      {appsState.status === 'loaded' && !hasApplications ? (
        <section
          aria-labelledby="add-first-application"
          data-testid="add-application-section"
          className="flex flex-col gap-4"
        >
          <h2 id="add-first-application" className="text-base font-semibold">
            Add your first application
          </h2>
          <DocsLink href={DOCS.requirements}>What your application needs</DocsLink>
          <RepositoryPicker applications={appsState.applications} />
        </section>
      ) : null}
    </div>
  );
}

// Each analysed application shows the badge the application page derives from
// the same readiness and deployments. A row has no badge of its own to fall
// back to: it shows a skeleton while loading and "Status unknown" when the
// reads fail, never a different status.
function ApplicationList({ applications }: { applications: Application[] }) {
  const [badges, setBadges] = useState<ReadonlyMap<string, ApplicationPresentation['badge']>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const analysed = applications.filter((app) => app.analysisStatus === 'COMPLETE');
    const show = (id: string, badge: ApplicationPresentation['badge']) => {
      if (!cancelled) setBadges((current) => new Map(current).set(id, badge));
    };
    void (async () => {
      const deployments = await fetchDeployments({ includeDeleted: true }).catch(() => null);
      await mapWithConcurrency(analysed, READINESS_FETCH_CONCURRENCY, async (app) => {
        if (deployments === null) return show(app.id, STATUS_UNKNOWN_BADGE);
        try {
          const readiness = await fetchReadiness(app.id);
          show(
            app.id,
            applicationListBadge(
              { id: app.id, name: app.name, defaultBranch: app.defaultBranch },
              readiness,
              deployments.filter((d) => d.applicationId === app.id),
            ),
          );
        } catch {
          show(app.id, STATUS_UNKNOWN_BADGE);
        }
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [applications]);

  return (
    <Card className="py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <ApplicationRow key={app.id} application={app} badge={badges.get(app.id) ?? null} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// The whole row opens the application; the name link is the same
// destination for keyboard and assistive-technology users, so the trailing
// "View" is decoration rather than a second control.
function ApplicationRow({
  application,
  badge,
}: {
  application: Application;
  badge: ApplicationPresentation['badge'] | null;
}) {
  const router = useRouter();
  const href = `/dashboard/applications/${application.id}`;
  const shown = application.analysisStatus === 'COMPLETE' ? badge : analysisBadge(application);
  return (
    <TableRow
      data-testid={`app-card-${application.id}`}
      className="cursor-pointer"
      onClick={() => router.push(href)}
    >
      <TableCell className="font-medium">
        <Link
          href={href}
          data-testid={`app-card-name-${application.id}`}
          className="hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {application.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{application.repoFullName}</TableCell>
      <TableCell>
        {shown ? (
          <Badge variant={shown.variant} data-testid={`app-card-badge-${application.id}`}>
            {shown.label}
          </Badge>
        ) : (
          <Skeleton className="h-5 w-20" />
        )}
      </TableCell>
      <TableCell className="text-right">
        <span
          aria-hidden
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground"
        >
          View
          <ArrowRight className="size-4" />
        </span>
      </TableCell>
    </TableRow>
  );
}

// The application page's badges for an analysis that has not completed.
function analysisBadge(app: Application): ApplicationPresentation['badge'] {
  if (app.analysisStatus === 'FAILED') return { label: 'Analysis failed', variant: 'destructive' };
  if (app.analysisStatus === 'PENDING') return { label: 'Not analysed', variant: 'secondary' };
  return { label: 'Analysing', variant: 'info' };
}
