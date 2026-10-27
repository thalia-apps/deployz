'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest, errorMessage } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';

// Destructive action: type-to-confirm instead of a modal (there is no dialog
// primitive in this app). The API blocks deletion with 409 OWNERSHIP_REQUIRED
// while the user still owns an organization with other members — that
// message already names the organizations, so it is shown as-is.
export function DeleteAccount({ email }: { email: string }) {
  const router = useRouter();
  const [confirmEmail, setConfirmEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmEmail.trim().toLowerCase() === email.toLowerCase();

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canDelete) return;
    setPending(true);
    setError(null);
    try {
      await apiRequest('/api/account', { method: 'DELETE', body: { confirmEmail } });
      await authClient.signOut();
      router.push('/sign-in');
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>This permanently deletes your account. This cannot be undone.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmEmail">
              Type <span className="font-medium text-foreground">{email}</span> to confirm
            </Label>
            <Input
              id="confirmEmail"
              data-testid="delete-account-confirm"
              value={confirmEmail}
              onChange={(event) => setConfirmEmail(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <Button
              data-testid="delete-account-submit"
              type="submit"
              variant="destructive"
              disabled={!canDelete}
              loading={pending}
              loadingText="Deleting account…"
            >
              Delete account
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
