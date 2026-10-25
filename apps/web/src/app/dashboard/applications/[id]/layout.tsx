'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { ApplicationHeader } from './application-header';
import { ApplicationPageProvider, useApplicationPage } from './application-page-context';
import { ApplicationTabs } from './application-tabs';

export default function ApplicationLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');

  return (
    <ApplicationPageProvider key={id} id={id}>
      <ApplicationShell>{children}</ApplicationShell>
    </ApplicationPageProvider>
  );
}

// The shared shell for one application: back link, compact state-aware
// header, route tabs, then the active tab's own page content. Everything
// below reads from the single `ApplicationPageProvider` so the header, the
// tabs and the tab content never disagree about the application's state.
function ApplicationShell({ children }: { children: ReactNode }) {
  const { notFound } = useApplicationPage();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/applications">
            <ArrowLeft aria-hidden className="size-4" />
            Applications
          </Link>
        </Button>
      </div>
      {notFound ? (
        <section
          aria-labelledby="application-not-found"
          data-testid="application-not-found"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="application-not-found" className="text-lg font-semibold">
            Application not found
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Not found, or you don&apos;t have access.</p>
        </section>
      ) : (
        <>
          <ApplicationHeader />
          <ApplicationTabs />
          {children}
        </>
      )}
    </div>
  );
}
