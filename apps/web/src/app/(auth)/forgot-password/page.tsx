'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

export default function ForgotPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: failure } = await authClient.requestPasswordReset({
      email: String(form.get('email') ?? ''),
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? "Couldn't send the email. Try again.");
      return;
    }
    setSent(true);
  }

  return (
    <Card className="w-full max-w-sm shadow-sm">
      <CardHeader>
        <h1 className="text-lg font-semibold tracking-tight">Forgot password</h1>
      </CardHeader>
      <CardContent>
        {sent ? (
          <p role="status" className="text-sm text-muted-foreground">
            If an account uses this email address, we sent a link to reset the password. The link is
            valid for 1 hour.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <Button type="submit" className="w-full" loading={pending} loadingText="Sending…">
              Send reset link
            </Button>
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
          </form>
        )}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
