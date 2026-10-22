'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VerifyEmailPrompt } from '@/components/verify-email-prompt';
import { ApiRequestError, apiRequest, errorMessage } from '@/lib/api-client';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '@/lib/organization-vocabulary';

// §41 screen 18 team management — invite by email. Owner/admin only
// (enforced by the caller). Shows the server's message for 409
// ALREADY_MEMBER / ALREADY_INVITED as-is (§65).
export function InviteMemberForm({ userEmail }: { userEmail: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNeedsVerification(false);
    try {
      await apiRequest('/api/organization/invitations', { method: 'POST', body: { email, role } });
      setEmail('');
      setRole('member');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerification(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="inviteEmail">Email</Label>
          <Input
            id="inviteEmail"
            type="email"
            data-testid="invite-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="inviteRole">Role</Label>
          <select
            id="inviteRole"
            data-testid="invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as 'admin' | 'member')}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            {ASSIGNABLE_ROLES.map((assignableRole) => (
              <option key={assignableRole} value={assignableRole}>
                {ROLE_LABELS[assignableRole]}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="submit"
          disabled={email.trim().length === 0}
          loading={pending}
          loadingText="Sending invitation…"
          data-testid="invite-submit"
        >
          Send invitation
        </Button>
      </div>
      {needsVerification ? <VerifyEmailPrompt email={userEmail} /> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
