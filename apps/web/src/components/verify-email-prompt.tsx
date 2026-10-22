'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

// Shown wherever the API answers EMAIL_NOT_VERIFIED. The verification link
// brings the user back to the page they are on.
export function VerifyEmailPrompt({ email }: { email: string }) {
  const [pending, setPending] = useState(false);

  async function onResend(): Promise<void> {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: window.location.href,
    });
    setPending(false);
    if (error) {
      toast.error("We couldn't send the email. Try again in a moment.");
      return;
    }
    toast.success('Verification email sent.');
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Verify your email address first. Open the verification link we sent to{' '}
        <span className="font-medium text-foreground">{email}</span>, then reload this page.
      </p>
      <div>
        <Button variant="outline" loading={pending} loadingText="Sending email…" onClick={onResend}>
          Resend verification email
        </Button>
      </div>
    </div>
  );
}
