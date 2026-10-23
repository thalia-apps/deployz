import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// A link to a page of the product documentation (lib/docs-links.ts). It
// opens in a new tab so the reader keeps their place in the app.
export function DocsLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button asChild variant="link" className={cn('h-auto w-fit px-0', className)}>
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink aria-hidden className="size-3.5" />
      </a>
    </Button>
  );
}
