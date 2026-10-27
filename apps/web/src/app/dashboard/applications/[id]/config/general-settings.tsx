'use client';

import { CircleAlert, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { GithubReturnNotice } from '@/components/github-return-notice';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api-client';
import { deleteApplication, updateApplication, type Application } from '@/lib/applications';
import {
  fetchApplicationGithubStatus,
  reconnectGithub,
  REPOSITORY_CONNECTION_LABELS,
  type ApplicationGithubStatus,
} from '@/lib/github';

import { useApplicationPage } from '../application-page-context';

// The Configuration tab's "Settings" panel — the application name, its
// (read-only) repository, re-analysis, and the danger zone. Moved here as is from the old
// overview page: same requests, same copy, same safeguards.
export function GeneralSettings() {
  const { data, loading, refresh, reanalyse, reanalysing } = useApplicationPage();

  if (loading) return <GeneralSettingsSkeleton />;
  if (!data) return null;

  return (
    <div id="settings" className="flex scroll-mt-20 flex-col gap-6">
      <section aria-labelledby="general" className="flex flex-col gap-3">
        <h2 id="general" className="text-base font-semibold">
          General
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <ApplicationNameField application={data.application} onRenamed={refresh} />
            <GithubReturnNotice />
            <RepositoryDetails application={data.application} />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <div>
                <p className="text-sm font-medium">Repository analysis</p>
                <p className="text-sm text-muted-foreground">Analyse the default branch again.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={data.application.analysisStatus === 'ANALYZING'}
                loading={reanalysing}
                loadingText="Starting analysis…"
                onClick={() => void reanalyse()}
                data-testid="settings-reanalyse"
              >
                <RefreshCw aria-hidden />
                Re-analyse
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <DangerZone application={data.application} hasDeployments={data.deployments.length > 0} />
    </div>
  );
}

function ApplicationNameField({
  application,
  onRenamed,
}: {
  application: Application;
  onRenamed: () => Promise<void>;
}) {
  const [name, setName] = useState(application.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => setName(application.name), [application.name]);

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === application.name) {
      setName(application.name);
      return;
    }
    setSaving(true);
    try {
      await updateApplication(application.id, { name: trimmed });
      toast.success('Application renamed.');
      await onRenamed();
    } catch (caught) {
      toast.error(errorMessage(caught, "Couldn't rename the application. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="app-name-input">Application name</Label>
      <div className="flex items-center gap-2">
        <Input
          id="app-name-input"
          data-testid="app-name-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="max-w-sm"
        />
        <Button onClick={() => void save()} loading={saving} loadingText="Saving name…" data-testid="app-name-save">
          Save name
        </Button>
      </div>
    </div>
  );
}

// GitHub access is managed for the whole organization in Settings; this
// shows whether Deployz can read THIS repository now, and the one action
// that restores it. There is no disconnect here.
function RepositoryDetails({ application }: { application: Application }) {
  const [github, setGithub] = useState<ApplicationGithubStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setGithub(await fetchApplicationGithubStatus(application.id));
    } catch {
      setGithub(null);
    }
  }, [application.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = github ? REPOSITORY_CONNECTION_LABELS[github.status] : null;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Repository</dt>
        <dd>{application.repoFullName}</dd>
        <dt className="text-muted-foreground">Default branch</dt>
        <dd>{application.defaultBranch}</dd>
        {status ? (
          <>
            <dt className="text-muted-foreground">GitHub</dt>
            <dd>
              <Badge variant={status.badge} data-testid="repository-connection-status">
                {status.label}
              </Badge>
            </dd>
          </>
        ) : null}
      </dl>
      {github && github.status !== 'connected' ? (
        <RepositoryAccessAlert application={application} github={github} onReconnected={load} />
      ) : null}
    </div>
  );
}

const REPOSITORY_ACCESS_REASONS: Record<Exclude<ApplicationGithubStatus['status'], 'connected'>, string> = {
  disconnected: 'GitHub is disconnected for this organization.',
  access_issue: 'GitHub removed or suspended the installation that gives Deployz access to this repository.',
  repository_inaccessible: 'GitHub is connected, but the installation does not give Deployz access to this repository.',
  not_connected: 'This application is not connected to a GitHub installation.',
};

function RepositoryAccessAlert({
  application,
  github,
  onReconnected,
}: {
  application: Application;
  github: ApplicationGithubStatus;
  onReconnected: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const returnTo = `/dashboard/applications/${application.id}/config`;
  const reason = REPOSITORY_ACCESS_REASONS[github.status as Exclude<ApplicationGithubStatus['status'], 'connected'>];
  const canReconnect =
    github.canConnect && github.installationId !== null && (github.status === 'disconnected' || github.status === 'access_issue');

  async function reconnect(): Promise<void> {
    if (!github.installationId) return;
    setPending(true);
    try {
      if ((await reconnectGithub(github.installationId, github.connectUrl, returnTo)) === 'reconnected') {
        toast.success('GitHub reconnected.');
        await onReconnected();
      }
    } catch (caught) {
      toast.error(errorMessage(caught, "Couldn't reconnect GitHub. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Alert data-testid="repository-access-alert">
      <CircleAlert aria-hidden />
      <AlertTitle>Deployz cannot read this repository</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <p>
          {reason} Analysis and new release builds are paused. Existing releases and running customer deployments are
          not affected.
        </p>
        {canReconnect ? (
          <Button
            size="sm"
            loading={pending}
            loadingText="Reconnecting GitHub…"
            onClick={() => void reconnect()}
            data-testid="repository-reconnect"
          >
            Reconnect GitHub
          </Button>
        ) : null}
        {github.status === 'repository_inaccessible' && github.manageUrl ? (
          <Button size="sm" variant="outline" asChild>
            <a href={github.manageUrl} target="_blank" rel="noreferrer">
              Manage access on GitHub
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        {!github.canConnect && github.status !== 'repository_inaccessible' ? (
          <p className="text-xs">Ask an owner or admin of your organization to reconnect GitHub.</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

// Removing an application (DELETE /api/applications/:id) is refused by the
// API whenever any deployment record exists for it — even a removed one —
// because it deletes the application's configs and releases in Deployz, and
// never touches anything in a customer's AWS account. Once the page's own
// data already shows a deployment, there is no point sending the vendor into
// a dialog that only the server will reject — `hasDeployments` says so up
// front instead.
function DangerZone({ application, hasDeployments }: { application: Application; hasDeployments: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === application.repoFullName;

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await deleteApplication(application.id);
      router.push('/dashboard/applications');
    } catch (err) {
      if ((err as { code?: string }).code === 'APPLICATION_HAS_DEPLOYMENTS') {
        setError((err as Error).message);
      } else {
        setError("Couldn't remove the application. Try again.");
      }
      setPending(false);
    }
  }

  if (hasDeployments) {
    return (
      <section aria-labelledby="danger-heading" className="flex flex-col gap-3 border-t pt-6">
        <h2 id="danger-heading" className="text-base font-semibold text-destructive">
          Danger zone
        </h2>
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col gap-2 py-4" data-testid="delete-app-unavailable">
            <p className="text-sm font-medium">Removal unavailable</p>
            <p className="text-sm text-muted-foreground">
              Applications with deployment history can&apos;t be removed.
            </p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section aria-labelledby="danger-heading" className="flex flex-col gap-3 border-t pt-6">
      <h2 id="danger-heading" className="text-base font-semibold text-destructive">
        Danger zone
      </h2>
      <Card className="border-destructive/40">
        <CardContent className="flex flex-col gap-3 py-4">
          <p className="text-sm font-medium text-destructive">Remove this application?</p>
          <p className="text-sm text-muted-foreground">
            Permanently removes the application, its releases, and its saved variables from Deployz.
            Only possible before the first deployment.
          </p>
          <AlertDialog
            open={open}
            onOpenChange={(next) => {
              if (!next) setError(null);
              setOpen(next);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                data-testid="delete-app-trigger"
              >
                <Trash2 className="size-3.5" aria-hidden />
                Remove application
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove this application?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the application, its releases, and its saved environment
                  variables from Deployz. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delete-app-confirm">
                  Type <span className="font-medium">{application.repoFullName}</span> to confirm.
                </Label>
                <Input
                  id="delete-app-confirm"
                  data-testid="delete-app-confirm"
                  aria-label={`Type ${application.repoFullName} to confirm`}
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  className="max-w-xs"
                />
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmText('')}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(event) => {
                    // The action closes the dialog by default; the request needs it
                    // open until the API has answered.
                    event.preventDefault();
                    void onConfirm();
                  }}
                  loading={pending}
                  loadingText="Removing application…"
                  disabled={!confirmed}
                  data-testid="delete-app-button"
                >
                  Remove application
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </section>
  );
}

function GeneralSettingsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="general-settings-loading">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}
