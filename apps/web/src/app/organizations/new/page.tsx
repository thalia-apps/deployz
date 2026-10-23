import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CreateOrganizationForm } from '@/components/create-organization-form';
import { DocsLink } from '@/components/docs-link';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { DOCS } from '@/lib/docs-links';
import { fetchMe } from '@/lib/me';

// Reachable both as the "you have no organization yet" landing spot (the
// dashboard layout redirects here) and as a plain "create another
// organization" screen for people who already have one.
export default async function NewOrganizationPage() {
  const me = await fetchMe();
  if (!me) {
    redirect('/sign-in');
  }
  const hasOrganizations = me.organizations.length > 0;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 className="font-heading text-base leading-snug font-medium">Create organization</h1>
        {hasOrganizations ? null : (
          <CardDescription>Create an organization to continue.</CardDescription>
        )}
        <DocsLink href={DOCS.organizationAndTeam}>About organizations and teams</DocsLink>
      </CardHeader>
      <CardContent>
        <CreateOrganizationForm />
        {hasOrganizations ? (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
              Back to dashboard
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
