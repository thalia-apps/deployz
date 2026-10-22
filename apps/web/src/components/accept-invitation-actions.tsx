'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { apiRequest, errorMessage } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';

// Accept / decline a pending invitation. Both actions route through the API
// (never Better Auth directly) since organization membership lives there.
export function AcceptInvitationActions({ id }: { id: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(action: 'accept' | 'reject'): Promise<void> {
    setPending(action);
    setError(null);
    try {
      await apiRequest(`/api/invitations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      if (action === 'accept') {
        router.push('/dashboard');
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button
          data-testid="invitation-accept"
          disabled={pending === 'reject'}
          loading={pending === 'accept'}
          loadingText="Accepting invitation…"
          onClick={() => respond('accept')}
        >
          Accept
        </Button>
        <Button
          data-testid="invitation-decline"
          variant="outline"
          disabled={pending === 'accept'}
          loading={pending === 'reject'}
          loadingText="Declining invitation…"
          onClick={() => respond('reject')}
        >
          Decline
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// Signs out so the visitor can sign back in with the invited email address.
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSignOut(): Promise<void> {
    setPending(true);
    try {
      await authClient.signOut();
      router.refresh();
    } catch {
      toast.error("We couldn't sign you out. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <Button variant="outline" loading={pending} loadingText="Signing out…" onClick={onSignOut}>
      Sign out
    </Button>
  );
}
