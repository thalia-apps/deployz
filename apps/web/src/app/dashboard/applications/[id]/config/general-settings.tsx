'use client';

import { RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { deleteApplication, updateApplication, type Application } from '@/lib/applications';

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
    } catch {
      toast.error("Couldn't rename the application. Try again.");
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

function RepositoryDetails({ application }: { application: Application }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Repository</dt>
      <dd>{application.repoFullName}</dd>
      <dt className="text-muted-foreground">Default branch</dt>
      <dd>{application.defaultBranch}</dd>
    </dl>
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
