'use client';

import { CircleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { GITHUB_RETURN_MESSAGES } from '@/lib/github';

// The GitHub setup callback sends the vendor back to the page that started
// the install with `?github=<result>`. A success is a toast; a failure stays
// on the page as an Alert so the vendor can act on it.
export function GithubReturnNotice() {
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('github');
    const notice = result === null ? undefined : GITHUB_RETURN_MESSAGES[result];
    if (!notice) return;
    if (notice.ok) toast.success(notice.message);
    else setFailure(notice.message);
  }, []);

  if (!failure) return null;
  return (
    <Alert variant="destructive" data-testid="github-return-failure">
      <CircleAlert aria-hidden />
      <AlertTitle>GitHub was not connected</AlertTitle>
      <AlertDescription>{failure}</AlertDescription>
    </Alert>
  );
}
