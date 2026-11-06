'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { authClient } from '@/lib/auth-client';
import { isSafeCallbackUrl } from '@/lib/safe-callback-url';

// The other auth page must keep the same destination — an invited visitor who
// switches between sign-in and sign-up still has to land back on their
// invitation.
function crossLink(callbackUrl: string | null): string {
  return isSafeCallbackUrl(callbackUrl)
    ? `/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : '/sign-up';
}

export default function SignInPage() {
  // useSearchParams needs a Suspense boundary at build time.
  return (
    <Suspense fallback={<SignInSkeleton />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInSkeleton() {
  return (
    <Card className="w-full max-w-sm shadow-sm" aria-busy="true">
      <CardHeader>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [codeStep, setCodeStep] = useState(false);

  function onSignedIn() {
    router.push(isSafeCallbackUrl(callbackUrl) ? callbackUrl : '/dashboard');
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { data, error: failure } = await authClient.signIn.email({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    });
    setPending(false);
    if (failure) {
      setError(failure.message ?? 'Sign-in failed. Check your email and password.');
      return;
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
      setCodeStep(true);
      return;
    }
    onSignedIn();
  }

  if (codeStep) {
    return <SignInCode onSignedIn={onSignedIn} onCancel={() => setCodeStep(false)} />;
  }

  return (
    <Card className="w-full max-w-sm shadow-sm">
      <CardHeader>
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" className="w-full" loading={pending} loadingText="Signing in…">
            Sign in
          </Button>
          {error ? <SignInError message={error} /> : null}
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No account yet?{' '}
          <Link href={crossLink(callbackUrl)} className="text-primary underline-offset-4 hover:underline">
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

const RESEND_COOLDOWN_SECONDS = 60;

// Second step for an account with two-factor sign-in on: the password was
// correct, and the session starts only after the emailed code.
function SignInCode({ onSignedIn, onCancel }: { onSignedIn: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const firstCodeSent = useRef(false);

  const sendCode = useCallback(async () => {
    setError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    const { error: failure } = await authClient.twoFactor.sendOtp();
    if (failure) {
      setError(failure.message ?? "We couldn't send the code. Sign in again.");
    }
  }, []);

  // Send the first code once, also when React mounts the step twice in development.
  useEffect(() => {
    if (firstCodeSent.current) return;
    firstCodeSent.current = true;
    void sendCode();
  }, [sendCode]);

  useEffect(() => {
    if (cooldown === 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error: failure } = await authClient.twoFactor.verifyOtp({ code });
    setPending(false);
    if (failure) {
      setError(failure.message ?? 'The code is not correct. Try again.');
      return;
    }
    onSignedIn();
  }

  return (
    <Card className="w-full max-w-sm shadow-sm">
      <CardHeader>
        <h1 className="text-lg font-semibold tracking-tight">Enter your sign-in code</h1>
        <CardDescription>We sent a 6-digit code to your email. The code is valid for 5 minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="code">Code</Label>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              className="font-mono tracking-widest"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            />
          </div>
          <Button type="submit" className="w-full" loading={pending} loadingText="Checking…">
            Continue
          </Button>
          {error ? <SignInError message={error} /> : null}
          <div className="flex items-center justify-between">
            <Button type="button" variant="link" className="px-0" onClick={onCancel}>
              Use a different account
            </Button>
            <Button
              type="button"
              variant="link"
              className="px-0"
              disabled={cooldown > 0}
              onClick={() => void sendCode()}
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SignInError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}
