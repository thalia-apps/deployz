'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

type Step = 'idle' | 'code' | 'password';

// Optional two-factor sign-in with an emailed code. Turning it on sends a
// code and turns it on only when the user enters that code, so it cannot
// lock out an address that does not receive mail. Turning it off needs the
// password.
export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('idle');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setStep('idle');
    setCode('');
    setPassword('');
    setError(null);
  }

  async function sendCode(): Promise<void> {
    setError(null);
    setPending(true);
    const { error: failure } = await authClient.twoFactor.sendOtp();
    setPending(false);
    if (failure) {
      setError(failure.message ?? "We couldn't send the code. Try again.");
      return;
    }
    setStep('code');
  }

  async function onVerify(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error: failure } = await authClient.twoFactor.verifyOtp({ code });
    setPending(false);
    if (failure) {
      setError(failure.message ?? 'The code is not correct. Try again.');
      return;
    }
    reset();
    router.refresh();
  }

  async function onDisable(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    const { error: failure } = await authClient.twoFactor.disable({ password });
    setPending(false);
    if (failure) {
      setError(failure.message ?? "Couldn't turn off two-factor sign-in. Try again.");
      return;
    }
    reset();
    router.refresh();
  }

  const errorLine = error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  if (step === 'code') {
    return (
      <form onSubmit={onVerify} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="twoFactorCode">Code</Label>
          <Input
            id="twoFactorCode"
            data-testid="two-factor-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            className="max-w-40 font-mono tracking-widest"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <p className="text-xs text-muted-foreground">
            Enter the 6-digit code we sent to your email.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="two-factor-confirm" type="submit" loading={pending} loadingText="Checking…">
            Turn on
          </Button>
          <Button type="button" variant="outline" onClick={reset}>
            Cancel
          </Button>
          {errorLine}
        </div>
      </form>
    );
  }

  if (step === 'password') {
    return (
      <form onSubmit={onDisable} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="twoFactorPassword">Current password</Label>
          <Input
            id="twoFactorPassword"
            data-testid="two-factor-password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            data-testid="two-factor-disable-confirm"
            type="submit"
            variant="destructive"
            loading={pending}
            loadingText="Turning off…"
          >
            Turn off
          </Button>
          <Button type="button" variant="outline" onClick={reset}>
            Cancel
          </Button>
          {errorLine}
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p data-testid="two-factor-status" className="text-sm text-muted-foreground">
        {enabled
          ? 'On. After your password, you enter a code that we send to your email.'
          : 'Off. You sign in with your password only.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? (
          <Button data-testid="two-factor-disable" variant="outline" onClick={() => setStep('password')}>
            Turn off
          </Button>
        ) : (
          <Button data-testid="two-factor-enable" loading={pending} loadingText="Sending code…" onClick={() => void sendCode()}>
            Turn on
          </Button>
        )}
        {errorLine}
      </div>
    </div>
  );
}
