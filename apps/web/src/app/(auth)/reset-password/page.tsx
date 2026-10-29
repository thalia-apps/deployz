'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { authClient } from '@/lib/auth-client';

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={<ResetPasswordSkeleton />}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordSkeleton() {
  return (
    <Card className="w-full max-w-sm shadow-sm" aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: failure } = await authClient.resetPassword({
      newPassword: String(form.get('password') ?? ''),
      token,
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? "Couldn't reset the password. Ask for a new link.");
      return;
    }
    router.push('/sign-in');
  }

  return (
    <Card className="w-full max-w-sm shadow-sm">
      <CardHeader>
        <h1 className="text-lg font-semibold tracking-tight">Reset password</h1>
      </CardHeader>
      <CardContent>
        {token ? (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>
            <Button type="submit" className="w-full" loading={pending} loadingText="Saving…">
              Reset password
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
        ) : (
          <p role="alert" className="text-sm text-muted-foreground">
            This reset link is not valid. Ask for a new link.
          </p>
        )}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="text-primary underline-offset-4 hover:underline">
            Ask for a new link
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
