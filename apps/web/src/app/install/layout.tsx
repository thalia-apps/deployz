import type { ReactNode } from 'react';

import { DeployzBrand } from '@/components/deployz-brand';
import { DocsLink } from '@/components/docs-link';
import { DOCS } from '@/lib/docs-links';

// Public install layout — deliberately distinct from the auth layout (a
// centered form card) and the dashboard shell (sidebar + user menu). The
// visitor is a CUSTOMER of a Deployz vendor holding a unique link; they have
// no Deployz account and never need one. No session fetch, no auth gate:
// the middleware matcher does not cover /install, and nothing here calls
// fetchMe().
export default function InstallLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <DeployzBrand size="sm" />
          <span className="text-xs text-muted-foreground">Private install link</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
          Anyone with this link can view this page. Don&apos;t share it.
          <DocsLink href={DOCS.customerGuide} className="text-xs">
            Customer guide
          </DocsLink>
        </div>
      </footer>
    </div>
  );
}
