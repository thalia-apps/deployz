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
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '@/lib/legal-links';
import { isSafeCallbackUrl } from '@/lib/safe-callback-url';

// The other auth page must keep the same destination — an invited visitor who
// switches between sign-in and sign-up still has to land back on their
// invitation.
function crossLink(callbackUrl: string | null): string {
  return isSafeCallbackUrl(callbackUrl)
    ? `/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : '/sign-in';
}

export default function SignUpPage() {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={<SignUpSkeleton />}>
      <SignUpForm />
    </Suspense>
  );
}

function SignUpSkeleton() {
  return (
    <Card className="w-full max-w-sm shadow-sm" aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}

function SignUpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error: failure } = await authClient.signUp.email({
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      // Where the e-mail verification link lands once the address is confirmed.
      callbackURL: `${window.location.origin}${isSafeCallbackUrl(callbackUrl) ? callbackUrl : '/dashboard'}`,
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? 'Sign-up failed. Try a different email address.');
      return;
    }
    router.push(isSafeCallbackUrl(callbackUrl) ? callbackUrl : '/dashboard');
  }

  return (
    <Card className="w-full max-w-sm shadow-sm">
      <CardHeader>
        <h1 className="text-lg font-semibold tracking-tight">Sign up</h1>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
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
          <Button type="submit" className="w-full" loading={pending} loadingText="Creating account…">
            Create account
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            By creating an account, you agree to the{' '}
            <a
              href={TERMS_OF_SERVICE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              Terms of Service
            </a>{' '}
            and the{' '}
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              Privacy Policy
            </a>
            .
          </p>
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
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href={crossLink(callbackUrl)} className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
