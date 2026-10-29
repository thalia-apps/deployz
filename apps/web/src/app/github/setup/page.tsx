import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DeployzBrand } from '@/components/deployz-brand';
import { DocsLink } from '@/components/docs-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { apiUrl } from '@/lib/api-url';
import { DOCS } from '@/lib/docs-links';
import { resolveGithubSetupRoute } from '@/lib/github-setup';
import { fetchMe } from '@/lib/me';

// The GitHub App's Setup URL. GitHub sends the vendor here right after they
// install or reconfigure the App. It has to work signed out: nothing
// guarantees the browser that installed the App also holds a Deployz session,
// and the API alone cannot ask for one without answering GitHub's redirect
// with a raw error.
export default async function GithubSetupPage({
  searchParams,
}: {
  searchParams: Promise<{
    installation_id?: string | undefined;
    state?: string | undefined;
    code?: string | undefined;
  }>;
}) {
  const { installation_id: installationId, state, code } = await searchParams;
  const me = await fetchMe();
  const route = resolveGithubSetupRoute({ installationId, state, code, signedIn: me !== null, apiUrl });

  // Binding needs the App's private key as well as the session, and only the
  // API holds the key — so the browser is handed straight to it.
  if (route.kind === 'bind') {
    redirect(route.href);
  }

  if (route.kind === 'sign-in') {
    return (
      <SetupCard title="Finish connecting GitHub">
        <p className="text-sm text-muted-foreground">
          Sign in to connect the GitHub App to your organization.
        </p>
        <Button asChild>
          <Link href={route.href}>Sign in</Link>
        </Button>
      </SetupCard>
    );
  }

  return (
    <SetupCard title="No installation to connect">
      <p className="text-sm text-muted-foreground">
        This link has no installation. Start again from your applications page.
      </p>
      <Button asChild variant="outline">
        <Link href="/dashboard/applications">Go to applications</Link>
      </Button>
      <DocsLink href={DOCS.github}>How to connect GitHub</DocsLink>
    </SetupCard>
  );
}

function SetupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <Link href="/" className="inline-flex">
        <DeployzBrand size="lg" />
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="font-heading text-base leading-snug font-medium">{title}</h1>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}
