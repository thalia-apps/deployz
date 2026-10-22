import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  AcceptInvitationActions,
  ResendVerificationButton,
  SignOutButton,
} from '@/components/accept-invitation-actions';
import { DeployzBrand } from '@/components/deployz-brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { fetchMe, fetchPublicInvitation, type PublicInvitation } from '@/lib/me';

const STATUS_MESSAGES: Record<Exclude<PublicInvitation['status'], 'pending'>, string> = {
  expired: 'This invitation has expired. Ask them to send you a new one.',
  canceled: 'This invitation was canceled by the organization.',
  rejected: 'This invitation was already declined.',
  accepted: 'This invitation was already accepted.',
};

// The invitation landing page reachable while signed out — the invitation
// email links here. Every terminal status gets its own honest message
// instead of an accept button that would just fail against the API.
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const invitation = await fetchPublicInvitation(id);

  if (!invitation) {
    return (
      <InvitationCard title="This invitation link is not valid">
        <p className="text-sm text-muted-foreground">
          This link does not match an invitation. Check the link or ask for a new one.
        </p>
      </InvitationCard>
    );
  }

  if (invitation.status !== 'pending') {
    return (
      <InvitationCard title={invitation.organizationName}>
        <p className="text-sm text-muted-foreground">{STATUS_MESSAGES[invitation.status]}</p>
      </InvitationCard>
    );
  }

  const me = await fetchMe();
  const callbackUrl = `/accept-invitation/${encodeURIComponent(id)}`;

  if (!me) {
    return (
      <InvitationCard title={`Join ${invitation.organizationName}`}>
        <p className="text-sm text-muted-foreground">
          {invitation.inviterName} invited{' '}
          <span className="font-medium text-foreground">{invitation.email}</span> to join{' '}
          {invitation.organizationName} on Deployz.
        </p>
        <p className="text-sm text-muted-foreground">
          Sign in or create an account using that exact email address to accept.
        </p>
        <div className="flex gap-2">
          <Button asChild>
            <Link href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`}>Sign up</Link>
          </Button>
        </div>
      </InvitationCard>
    );
  }

  // The API matches the invited address case-insensitively, so the screen has
  // to agree with it — otherwise a signed-in "Bob@example.com" would be told
  // to sign out for an invitation they can in fact accept.
  if (me.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    return (
      <InvitationCard title={`Join ${invitation.organizationName}`}>
        <p className="text-sm text-muted-foreground">
          This invitation is for{' '}
          <span className="font-medium text-foreground">{invitation.email}</span>. You are signed
          in as <span className="font-medium text-foreground">{me.user.email}</span>.
        </p>
        <p className="text-sm text-muted-foreground">
          Sign out, then sign in with the invited address to accept.
        </p>
        <SignOutButton />
      </InvitationCard>
    );
  }

  if (!me.user.emailVerified) {
    return (
      <InvitationCard title={`Join ${invitation.organizationName}`}>
        <p className="text-sm text-muted-foreground">
          Verify your email address first. Open the verification link we sent to{' '}
          <span className="font-medium text-foreground">{me.user.email}</span>, then reload this
          page to accept.
        </p>
        <ResendVerificationButton email={me.user.email} callbackUrl={callbackUrl} />
      </InvitationCard>
    );
  }

  return (
    <InvitationCard title={`Join ${invitation.organizationName}`}>
      <p className="text-sm text-muted-foreground">
        {invitation.inviterName} invited you to join {invitation.organizationName} as{' '}
        {invitation.role}.
      </p>
      <AcceptInvitationActions id={id} />
    </InvitationCard>
  );
}

function InvitationCard({ title, children }: { title: string; children: ReactNode }) {
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
