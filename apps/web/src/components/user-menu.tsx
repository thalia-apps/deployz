'use client';

import { BookOpen, ChevronDown, FileText, LogOut, Settings, Shield } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { authClient } from '@/lib/auth-client';
import { DOCS_URL } from '@/lib/docs-links';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '@/lib/legal-links';

const SETTINGS_HREF = '/dashboard/settings/profile';

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

// Both account menus sign out via the shared Better Auth client, then bounce
// to /sign-in.
function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut(): Promise<void> {
    setPending(true);
    try {
      await authClient.signOut();
      router.push('/sign-in');
      router.refresh();
    } catch {
      toast.error("We couldn't sign you out. Try again in a moment.");
      setPending(false);
    }
  }

  return { pending, signOut };
}

// Shared menu body: identity label, settings link, legal links, sign out. The label prop
// keeps the admin header's wording while the sidebar matches its own nav.
function UserMenuItems({
  name,
  email,
  settingsLabel,
  pending,
  onSignOut,
}: {
  name: string;
  email: string;
  settingsLabel: string;
  pending: boolean;
  onSignOut: () => void;
}) {
  return (
    <>
      <DropdownMenuLabel className="flex flex-col gap-0.5">
        <span className="font-medium">{name}</span>
        <span data-testid="user-menu-email" className="text-xs font-normal text-muted-foreground">
          {email}
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href={SETTINGS_HREF}>
          <Settings aria-hidden />
          {settingsLabel}
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          <BookOpen aria-hidden />
          Documentation
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noreferrer">
          <FileText aria-hidden />
          Terms of Service
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
          <Shield aria-hidden />
          Privacy Policy
        </a>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={pending} aria-busy={pending || undefined} onSelect={onSignOut}>
        {pending ? <Spinner aria-hidden className="size-4" /> : <LogOut aria-hidden />}
        {pending ? 'Signing out…' : 'Sign out'}
      </DropdownMenuItem>
    </>
  );
}

// Header account menu (Team Admin's header reuses it): avatar trigger with
// the name beside it.
export function UserMenu({ name, email }: { name: string; email: string }) {
  const { pending, signOut } = useSignOut();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="user-menu-trigger"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Avatar size="sm">
          <AvatarFallback>{initials(name) || '?'}</AvatarFallback>
        </Avatar>
        <span className="hidden font-medium sm:inline">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <UserMenuItems
          name={name}
          email={email}
          settingsLabel="Profile settings"
          pending={pending}
          onSignOut={signOut}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Sidebar-footer account menu (the shadcn sidebar nav-user pattern): avatar,
// full name, and chevron on one trigger that collapses to the avatar alone —
// the tooltip then names the user — while the dropdown keeps working.
export function SidebarUserMenu({ name, email }: { name: string; email: string }) {
  const { pending, signOut } = useSignOut();
  const { isMobile } = useSidebar();

  return (
    <TooltipProvider>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                data-testid="user-menu-trigger"
                size="lg"
                tooltip={name}
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar>
                  <AvatarFallback>{initials(name) || '?'}</AvatarFallback>
                </Avatar>
                <span className="truncate font-medium">{name}</span>
                <ChevronDown aria-hidden className="ml-auto text-muted-foreground" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isMobile ? 'bottom' : 'right'}
              align="end"
              sideOffset={4}
              className="w-56"
            >
              <UserMenuItems
                name={name}
                email={email}
                settingsLabel="Settings"
                pending={pending}
                onSignOut={signOut}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </TooltipProvider>
  );
}
