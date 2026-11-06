'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

// Changes the account password through Better Auth's built-in endpoint.
// Other sessions are revoked on success, matching the security expectation
// of a password change.
export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaved(false);
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword.length < 12) {
      setError('The new password must be at least 12 characters.');
      return;
    }

    setPending(true);
    const { error: failure } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? "Couldn't change your password. Try again.");
      return;
    }
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setSaved(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          data-testid="password-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          data-testid="password-new"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">At least 12 characters.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          data-testid="password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          data-testid="password-save"
          type="submit"
          loading={pending}
          loadingText="Saving password…"
        >
          Change password
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            Password changed. Other sessions were signed out.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
