'use client';

import { useEffect, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Error boundary for the customer install pages.
export default function InstallError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
        <CardDescription>Couldn&apos;t load this page. If it keeps failing, contact your software provider.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          loading={isPending}
          loadingText="Trying again…"
          onClick={() => startTransition(() => reset())}
        >
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
