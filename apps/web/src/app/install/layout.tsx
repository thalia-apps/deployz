import type { ReactNode } from 'react';

import { CustomerPageHeader } from '@/components/customer-page-header';

// Public install layout — deliberately distinct from the auth layout (a
// centered form card) and the dashboard shell (sidebar + user menu). The
// visitor is a CUSTOMER of a Deployz vendor holding a unique link; they have
// no Deployz account and never need one. No session fetch, no auth gate:
// the middleware matcher does not cover /install, and nothing here calls
// fetchMe().
export default function InstallLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <CustomerPageHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      <footer className="border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-xs text-muted-foreground">
          Only the verified owner email and the publisher can open this page.
        </div>
      </footer>
    </div>
  );
}
