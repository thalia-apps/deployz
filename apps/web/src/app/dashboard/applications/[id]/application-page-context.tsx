'use client';

import type { DeploymentPlan } from '@deployz/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  deriveApplicationPresentation,
  TEST_DEPLOYMENT_POLL_MS,
  type ApplicationPresentation,
  type InstallLinksInput,
} from '@/lib/application-state';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import { fetchApplication, fetchApplicationPlan, triggerAnalysis, type Application } from '@/lib/applications';
import { fetchDeploymentsForApplication, type FleetDeployment } from '@/lib/deployments';
import { fetchPublicInstallLinks } from '@/lib/public-install-links';
import { ANALYSIS_TAKING_LONGER_MS, fetchReadiness, type ApplicationReadiness } from '@/lib/readiness';
import { fetchReleases, type Release } from '@/lib/releases';
import { useStatusPoll } from '@/lib/use-status-poll';

export interface ApplicationPageData {
  application: Application;
  readiness: ApplicationReadiness;
  deployments: FleetDeployment[];
  /** INSTALL plan for the current effective manifest. Null while analysis is
   *  incomplete or the plan cannot be fetched. */
  plan: DeploymentPlan | null;
  installLinks: Exclude<InstallLinksInput, null>;
  /** 'error' when the releases fetch failed: the page says nothing about
   *  releases rather than guessing. */
  releases: Release[] | 'error';
}

export interface ApplicationPageContextValue {
  id: string;
  /** Null until the first load succeeds. */
  data: ApplicationPageData | null;
  /** True only while the first load is in flight. */
  loading: boolean;
  /** True when the API says this application does not exist for the viewer. */
  notFound: boolean;
  /** The one derived state every section of the page renders from. */
  presentation: ApplicationPresentation;
  /** Re-fetch everything now. Keeps the content on screen if it fails. */
  refresh: () => Promise<void>;
  /** Start a forced analysis, then refresh. */
  reanalyse: () => Promise<void>;
  reanalysing: boolean;
}

const ApplicationPageContext = createContext<ApplicationPageContextValue | null>(null);

export function useApplicationPage(): ApplicationPageContextValue {
  const value = useContext(ApplicationPageContext);
  if (!value) throw new Error('useApplicationPage must be used inside ApplicationPageProvider');
  return value;
}

async function loadApplicationPage(id: string): Promise<ApplicationPageData> {
  // First, alone: an application that does not exist makes every other
  // request for it fail too.
  const application = await fetchApplication(id);
  const [readiness, deployments, installLinks, releases] = await Promise.all([
    fetchReadiness(id),
    fetchDeploymentsForApplication(id),
    // The link is one card on the page: its failure must not take the page down.
    fetchPublicInstallLinks(id).catch(() => 'error' as const),
    // Same for releases: the state mapper says nothing about them rather
    // than taking the whole page down.
    fetchReleases(id).catch(() => 'error' as const),
  ]);
  // The plan endpoint returns 409 while analysis is still running.
  const plan =
    application.analysisStatus === 'COMPLETE' ? await fetchApplicationPlan(id).catch(() => null) : null;
  return { application, readiness, deployments, plan, installLinks, releases };
}

function present(
  data: ApplicationPageData | null,
  loading: boolean,
  stale: boolean,
  analysisTakingLonger: boolean,
): ApplicationPresentation {
  return deriveApplicationPresentation({
    data,
    installLinks: data ? data.installLinks : loading ? null : 'error',
    stale,
    analysisTakingLonger,
  });
}

export function ApplicationPageProvider({ id, children }: { id: string; children: ReactNode }) {
  const [reanalysing, setReanalysing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [restartCount, setRestartCount] = useState(0);
  const [takingLonger, setTakingLonger] = useState(false);
  const [intervalMs, setIntervalMs] = useState(TEST_DEPLOYMENT_POLL_MS);

  const fetcher = useCallback(async () => {
    try {
      return await loadApplicationPage(id);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'NOT_FOUND') setNotFound(true);
      throw caught;
    }
  }, [id]);
  const poll = useStatusPoll<ApplicationPageData>({
    fetcher,
    // A missing application stays missing: stop polling and retrying.
    enabled: !notFound,
    intervalMs,
    // A settled state arms no timer: loaders and polling stop at once. A
    // return to the tab, `refresh()` or `reanalyse()` starts the loop again.
    terminalIntervalMs: null,
    isTerminal: (data) => present(data, false, false, false).polling === null,
  });

  const presentation = useMemo(
    () => present(poll.data, poll.loading, poll.stale, takingLonger),
    [poll.data, poll.loading, poll.stale, takingLonger],
  );

  const nextIntervalMs = presentation.polling?.intervalMs ?? TEST_DEPLOYMENT_POLL_MS;
  useEffect(() => setIntervalMs(nextIntervalMs), [nextIntervalMs]);

  // The API can leave an application at ANALYZING when the worker never picks
  // the job up, so after a while the page offers a restart.
  const analysing = poll.data?.readiness.analysisStatus === 'ANALYZING';
  useEffect(() => {
    setTakingLonger(false);
    if (!analysing) return;
    const timer = setTimeout(() => setTakingLonger(true), ANALYSIS_TAKING_LONGER_MS);
    return () => clearTimeout(timer);
  }, [analysing, restartCount]);

  const { refresh } = poll;
  const reanalyse = useCallback(async (): Promise<void> => {
    setReanalysing(true);
    try {
      await triggerAnalysis(id, { force: true });
      setRestartCount((count) => count + 1);
      await refresh();
    } catch (caught) {
      toast.error(errorMessage(caught, "Couldn't start the analysis. Try again."));
    } finally {
      setReanalysing(false);
    }
  }, [id, refresh]);

  const value = useMemo<ApplicationPageContextValue>(
    () => ({ id, data: poll.data, loading: poll.loading, notFound, presentation, refresh, reanalyse, reanalysing }),
    [id, poll.data, poll.loading, notFound, presentation, refresh, reanalyse, reanalysing],
  );

  return <ApplicationPageContext.Provider value={value}>{children}</ApplicationPageContext.Provider>;
}
