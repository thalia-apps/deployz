'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CustomerAccessError, requestSignInCode, verifySignInCode } from '@/lib/customer-access';

const RESEND_AFTER_SECONDS = 60;

// The customer page's sign-in (docs/customer-access.md): the email that owns
// the deployment gets an 8-digit code. The request answers the same way for
// every email, so this screen never says whether an email has access.
export function CustomerSignIn({
  installLinkId,
  applicationName,
  publisherName,
}: {
  installLinkId: string;
  applicationName: string;
  publisherName: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  async function sendCode(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await requestSignInCode(installLinkId, email);
      setStep('code');
      setCode('');
      setResendIn(RESEND_AFTER_SECONDS);
    } catch (caught) {
      setError(
        caught instanceof CustomerAccessError && caught.status === 429
          ? 'Too many requests. Wait a minute, then try again.'
          : "Couldn't send the code. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function verify(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await verifySignInCode(installLinkId, code);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof CustomerAccessError && caught.code === 'TOO_MANY_ATTEMPTS'
          ? 'Too many wrong codes. Wait one hour, then request a new code.'
          : 'The code is not correct or has expired. Check the code, or request a new one.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{applicationName}</h1>
        <p className="text-sm text-muted-foreground">Published by {publisherName}</p>
      </header>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{step === 'email' ? 'Verify your email' : 'Enter the code'}</CardTitle>
          <CardDescription>
            {step === 'email'
              ? `Enter the email address that ${publisherName} has for this deployment. We send a code to it.`
              : `If ${email} has access to this deployment, we sent an 8-digit code to it. The code expires in 10 minutes.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'email' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void sendCode();
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="customer-email">Email</Label>
                <Input
                  id="customer-email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="name@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <Button type="submit" loading={pending} loadingText="Sending code…" className="w-fit">
                Send code
              </Button>
            </form>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="customer-code">Code</Label>
                <Input
                  id="customer-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{8}"
                  maxLength={8}
                  required
                  className="max-w-40 font-mono tracking-widest"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" loading={pending} loadingText="Checking…">
                  Continue
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resendIn > 0 || pending}
                  onClick={() => void sendCode()}
                >
                  {resendIn > 0 ? `Send a new code in ${resendIn} s` : 'Send a new code'}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="px-0"
                  onClick={() => {
                    setStep('email');
                    setError(null);
                  }}
                >
                  Use another email
                </Button>
              </div>
            </form>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <p className="max-w-md text-xs text-muted-foreground">
        No Deployz account or password is needed. If you do not get a code, ask {publisherName} which
        email address they have for you.
      </p>
    </div>
  );
}
