'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { useApplicationPage } from './application-page-context';

type TabValue = 'overview' | 'releases' | 'config';

function tabValueFromPathname(pathname: string): TabValue {
  if (pathname.endsWith('/releases')) return 'releases';
  if (pathname.endsWith('/config')) return 'config';
  return 'overview';
}

// Route tabs, controlled by the URL: the active tab always reflects
// `usePathname()`, and both a click and arrow-key activation (Radix's default
// automatic activation) navigate through `router.push`.
export function ApplicationTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const { id } = useApplicationPage();
  const value = tabValueFromPathname(pathname);

  const tabs: Array<{ value: TabValue; label: string; href: string }> = [
    { value: 'overview', label: 'Overview', href: `/dashboard/applications/${id}` },
    { value: 'releases', label: 'Releases', href: `/dashboard/applications/${id}/releases` },
    { value: 'config', label: 'Configuration', href: `/dashboard/applications/${id}/config` },
  ];

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const tab = tabs.find((candidate) => candidate.value === next);
        if (tab) router.push(tab.href);
      }}
    >
      <TabsList variant="line" aria-label="Application sections" className="w-full justify-start gap-2 sm:gap-4">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} asChild className="flex-none">
            <Link href={tab.href}>{tab.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
