'use client';

import { useEffect, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Error boundary for any page outside the dashboard and the install pages.
export default function RootError({
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
    <Card className="mx-auto my-10 w-full max-w-md">
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
        <CardDescription>Couldn&apos;t load this page.</CardDescription>
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
