'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { LINK_TOKEN_COOKIE } from '@/lib/link-token-cookie';

/**
 * Moves the link secret from the URL fragment into a path-scoped cookie so
 * the server page can send it to the API. The server never sees a fragment,
 * and the secret never appears in a request URL, an access log or a Referer.
 * The fragment is removed from the address bar through the router, because
 * the router writes its own copy of the URL back to the history entry.
 * `fallback` shows only when the URL carried no new secret, so a first visit
 * does not flash it.
 */
export function LinkTokenGate({
  path,
  current,
  fallback,
}: {
  /** The cookie path: the page URL the secret belongs to. */
  path: string;
  /** The secret the server already holds from the cookie, if any. */
  current?: string | undefined;
  fallback: ReactNode;
}) {
  const router = useRouter();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const fromHash =
      window.location.hash.length > 1 ? decodeURIComponent(window.location.hash.slice(1)) : '';
    if (fromHash === '') {
      setMissing(true);
      return;
    }
    if (fromHash === current) {
      router.replace(window.location.pathname);
      setMissing(true);
      return;
    }
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LINK_TOKEN_COOKIE}=${encodeURIComponent(fromHash)}; Path=${path}; SameSite=Strict${secure}`;
    router.replace(window.location.pathname);
  }, [path, current, router]);

  return missing ? fallback : null;
}
