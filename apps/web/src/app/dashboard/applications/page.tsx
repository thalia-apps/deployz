'use client';

import { ArrowRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { RepositoryPicker } from '@/components/repository-picker';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications, type Application } from '@/lib/applications';
import { applicationListBadge, type ApplicationPresentation } from '@/lib/application-state';
import { fetchDeployments } from '@/lib/deployments';
import { DOCS } from '@/lib/docs-links';
import {
  READINESS_STATE_PRESENTATION,
  fetchReadiness,
  readinessBadgeVariant,
  readinessStateFromVerdict,
} from '@/lib/readiness';
import { mapWithConcurrency } from '@/lib/map-with-concurrency';

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

// The list's own verdict ignores env decisions and deployments, so it could
// read "Ready" for an application the page calls "Needs input" or "Test
// failed". The page's derivation is reused, best effort: a failed fetch keeps
// the list's own badge.
function ApplicationList({ applications }: { applications: Application[] }) {
  const [badges, setBadges] = useState<ReadonlyMap<string, ApplicationPresentation['badge']>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deployments = await fetchDeployments().catch(() => null);
      if (deployments === null) return;
      const entries = await mapWithConcurrency(
        applications.filter((app) => app.analysisStatus === 'COMPLETE'),
        READINESS_FETCH_CONCURRENCY,
        async (app) => {
          try {
            const readiness = await fetchReadiness(app.id);
            const badge = applicationListBadge(
              { id: app.id, name: app.name, defaultBranch: app.defaultBranch },
              readiness,
              deployments.filter((d) => d.applicationId === app.id),
            );
            return [app.id, badge] as const;
          } catch {
            return null;
          }
        },
      );
      if (!cancelled) {
        setBadges(new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
      }
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
  const label = badge?.label ?? applicationBadgeLabel(application);
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
        <Badge variant={badge?.variant ?? applicationBadgeVariant(application)} data-testid={`app-card-badge-${application.id}`}>
          {label}
        </Badge>
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

function applicationBadgeLabel(app: Application): string {
  if (app.compatibilityStatus) {
    return READINESS_STATE_PRESENTATION[readinessStateFromVerdict(app.compatibilityStatus)].label;
  }
  if (app.analysisStatus === 'FAILED') return 'Analysis failed';
  return 'Analysing';
}

function applicationBadgeVariant(app: Application): BadgeVariant {
  if (app.compatibilityStatus) {
    return readinessBadgeVariant(readinessStateFromVerdict(app.compatibilityStatus));
  }
  if (app.analysisStatus === 'FAILED') return 'destructive';
  return 'info';
}
