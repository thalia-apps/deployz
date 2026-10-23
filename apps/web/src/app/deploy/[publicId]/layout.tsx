import type { ReactNode } from 'react';

import { CustomerPageHeader } from '@/components/customer-page-header';

// The hosted deploy-link surfaces (/deploy/:id and its security sub-page).
// One centered column — max-w-3xl (768px) keeps the dominant progress card
// and its two-column rows readable on desktop while the page stays clean on
// mobile. Like the install layout, no session fetch and no auth gate: the
// token in the URL is the only credential.
export default function DeployLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <CustomerPageHeader />
      <main className="mx-auto w-full max-w-3xl px-4 py-10">{children}</main>
    </>
  );
}
