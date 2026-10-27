import { Building2 } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { GithubConnectionsCard } from '@/components/github-connections-card';
import { OrganizationDangerZone } from '@/components/organization-danger-zone';
import { OrganizationForm } from '@/components/organization-form';
import { fetchOrganization } from '@/lib/organization';
import { ROLE_LABELS, subscriptionStatusLabel } from '@/lib/organization-vocabulary';

// §41 screen 18 organization settings. Rename (PATCH /api/organization) is
// owner/admin only; a plain member sees the name as read-only (§65 — no dead
// controls). Deletion (DELETE /api/organization) is owner only and lives in
// its own danger-zone card with a type-to-confirm step. The GitHub card
// shows the organization's GitHub connections (owner/admin change them).
export default async function SettingsPage() {
  const org = await fetchOrganization();
  const canRename = org.role === 'owner' || org.role === 'admin';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Organization</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetaRow
              label="Billing"
              value={subscriptionStatusLabel(org.subscriptionStatus)}
              badge={<Badge variant="secondary">{subscriptionStatusLabel(org.subscriptionStatus)}</Badge>}
            />
            <MetaRow
              label="Created"
              value={new Date(org.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
            <MetaRow
              label="Your role"
              value={ROLE_LABELS[org.role]}
              badge={<Badge variant="outline">{ROLE_LABELS[org.role]}</Badge>}
            />
            <MetaRow
              label="Members"
              value={`${org.memberCount} ${org.memberCount === 1 ? 'member' : 'members'}`}
              link="/dashboard/settings/members"
            />
          </div>
          {canRename ? (
            <OrganizationForm organization={org} />
          ) : (
            <div className="flex flex-col gap-2">
              <Label>Organization name</Label>
              <p className="text-sm font-medium">{org.name}</p>
              <p className="text-xs text-muted-foreground">Only an owner or admin can rename.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <GithubConnectionsCard />

      {org.role === 'owner' ? <OrganizationDangerZone organizationName={org.name} /> : null}
    </div>
  );
}

function MetaRow({
  label,
  value,
  badge,
  link,
}: {
  label: string;
  value: string;
  badge?: ReactNode;
  link?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm font-medium">
        {link ? (
          <Link href={link} className="underline-offset-4 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
        {badge}
      </dd>
    </div>
  );
}
