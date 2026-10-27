'use client';

import { CircleAlert, ExternalLink, GitBranch } from 'lucide-react';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api-client';
import {
  disconnectGithubInstallation,
  fetchGithubInstallations,
  GITHUB_CONNECTION_LABELS,
  githubConnectHref,
  reconnectGithub,
  type GithubInstallation,
  type GithubInstallationsResult,
} from '@/lib/github';

const SETTINGS_PATH = '/dashboard/settings';

type CardState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: GithubInstallationsResult };

// The organization's GitHub connections (Settings). Owners and admins
// disconnect and reconnect; other members see the status only. A disconnect
// is local to Deployz: the App stays installed on GitHub until the account
// owner removes it there, which "Manage access" opens.
export function GithubConnectionsCard() {
  const [state, setState] = useState<CardState>({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      setState({ status: 'loaded', data: await fetchGithubInstallations() });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card id="github" className="scroll-mt-20" data-testid="github-connections">
      <CardHeader>
        <div className="flex items-center gap-2">
          <GitBranch className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>GitHub</CardTitle>
        </div>
        <CardDescription>Deployz reads your repositories through these GitHub connections.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <GithubReturnNotice />
        {state.status === 'loading' ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {state.status === 'error' ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>Couldn&apos;t load the GitHub connection</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              Try again in a moment.
              <Button variant="outline" size="sm" onClick={() => void load()} data-testid="github-connections-retry">
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {state.status === 'loaded' ? <ConnectionList data={state.data} onChanged={load} /> : null}
      </CardContent>
    </Card>
  );
}

function ConnectionList({ data, onChanged }: { data: GithubInstallationsResult; onChanged: () => Promise<void> }) {
  if (data.installations.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">No GitHub account is connected.</p>
        {data.canManage && data.connectUrl ? (
          <Button asChild data-testid="github-connect">
            <a href={githubConnectHref(data.connectUrl, SETTINGS_PATH)}>Connect GitHub</a>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {data.installations.map((installation) => (
        <ConnectionRow
          key={installation.id}
          installation={installation}
          canManage={data.canManage}
          connectUrl={data.connectUrl}
          onChanged={onChanged}
        />
      ))}
      {!data.canManage ? (
        <li className="px-4 py-3 text-xs text-muted-foreground">Only an owner or admin can change the GitHub connection.</li>
      ) : null}
    </ul>
  );
}

const STATUS_DETAILS: Record<GithubInstallation['status'], string> = {
  active: 'Deployz can read the repositories this installation gives it.',
  disconnected:
    'Deployz does not use this connection. The Deployz GitHub App is still installed on GitHub until you remove it there.',
  access_issue: 'GitHub removed or suspended this installation. Reconnect to restore access.',
};

function ConnectionRow({
  installation,
  canManage,
  connectUrl,
  onChanged,
}: {
  installation: GithubInstallation;
  canManage: boolean;
  connectUrl: string | null;
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const status = GITHUB_CONNECTION_LABELS[installation.status];

  async function reconnect(): Promise<void> {
    setPending(true);
    try {
      if ((await reconnectGithub(installation.id, connectUrl, SETTINGS_PATH)) === 'reconnected') {
        toast.success('GitHub reconnected.');
        await onChanged();
      }
    } catch (caught) {
      toast.error(errorMessage(caught, "Couldn't reconnect GitHub. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`github-connection-${installation.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{installation.accountLogin}</span>
          <Badge variant={status.badge} data-testid="github-connection-status">
            {status.label}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{STATUS_DETAILS[installation.status]}</p>
        <p className="text-xs text-muted-foreground">{applicationCountLabel(installation.applicationCount)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <a href={installation.manageUrl} target="_blank" rel="noreferrer" data-testid="github-manage-access">
            Manage access
            <ExternalLink aria-hidden />
          </a>
        </Button>
        {canManage && installation.status === 'active' ? (
          <DisconnectDialog installation={installation} onChanged={onChanged} />
        ) : null}
        {canManage && installation.status !== 'active' ? (
          <Button
            size="sm"
            loading={pending}
            loadingText="Reconnecting GitHub…"
            onClick={() => void reconnect()}
            data-testid="github-reconnect"
          >
            Reconnect
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function DisconnectDialog({
  installation,
  onChanged,
}: {
  installation: GithubInstallation;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await disconnectGithubInstallation(installation.id);
      setOpen(false);
      toast.success('GitHub disconnected.');
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Couldn't disconnect GitHub. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="github-disconnect">
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <p>
                Deployz will no longer be able to access repositories through this connection or build new releases
                from them.
              </p>
              <p>Existing applications, releases, and running customer deployments will remain intact.</p>
              {installation.applicationCount > 0 ? (
                <p className="font-medium text-foreground" data-testid="github-disconnect-affected">
                  {installation.applicationCount === 1
                    ? '1 application uses this connection.'
                    : `${installation.applicationCount} applications use this connection.`}
                </p>
              ) : null}
              <p>
                The Deployz GitHub App stays installed on GitHub. To remove its access on GitHub too, use Manage
                access.
              </p>
              <p>You can reconnect GitHub at any time.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
            loading={pending}
            loadingText="Disconnecting GitHub…"
            data-testid="github-disconnect-confirm"
          >
            Disconnect GitHub
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function applicationCountLabel(count: number): string {
  if (count === 0) return 'No applications use this connection.';
  return count === 1 ? 'Used by 1 application.' : `Used by ${count} applications.`;
}
