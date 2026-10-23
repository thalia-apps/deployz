'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { RepositoryPicker } from '@/components/repository-picker';
import { fetchApplications, type Application } from '@/lib/applications';
import { DOCS } from '@/lib/docs-links';

// Every application after the first is added here (the first one's picker
// sits inline on the Applications page). The existing applications are only
// needed to mark repositories that are already added — if that list can't be
// read the picker still works, because the API refuses a duplicate anyway
// and its message names the application that already has the repository.
export default function NewApplicationPage() {
  const [applications, setApplications] = useState<Application[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchApplications()
      .then((loaded) => {
        if (!cancelled) setApplications(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/applications"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Applications
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add application</h1>
        <DocsLink href={DOCS.requirements}>What your application needs</DocsLink>
      </div>
      <RepositoryPicker applications={applications} />
    </div>
  );
}
