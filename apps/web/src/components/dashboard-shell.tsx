'use client';

import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import type { OrganizationSummary } from '@/lib/organization-vocabulary';

interface DashboardShellProps {
  user: { name: string; email: string };
  organizations: OrganizationSummary[];
  activeOrganizationId: string | null;
  children: ReactNode;
}

// App shell on the shadcn Sidebar architecture: AppSidebar (brand, sidebar
// trigger, org switcher, navigation, account menu). Below md the sidebar is a
// sheet, so a slim bar carries the trigger that opens it. Session data arrives
// as props from the server layout, which re-validates it against the API on
// every render. Pages get their padding and base spacing from the single
// content area here (inside the SidebarInset main), not from each page.
export function DashboardShell({
  user,
  organizations,
  activeOrganizationId,
  children,
}: DashboardShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar
        user={user}
        organizations={organizations}
        activeOrganizationId={activeOrganizationId}
      />
      {/* min-w-0: a wide table scrolls inside its own container instead of
          widening the page beside the tablet sidebar. */}
      <SidebarInset className="min-w-0">
        <div className="sticky top-0 z-10 flex h-12 items-center border-b bg-background px-4 md:hidden">
          <SidebarTrigger aria-label="Open sidebar" />
        </div>
        <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6 md:pb-16 lg:p-8">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
