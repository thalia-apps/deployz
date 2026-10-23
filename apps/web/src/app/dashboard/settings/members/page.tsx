import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { DocsLink } from '@/components/docs-link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InviteMemberForm } from '@/components/invite-member-form';
import { LeaveOrganizationButton, MembersList } from '@/components/members-list';
import { PendingInvitations } from '@/components/pending-invitations';
import { DOCS } from '@/lib/docs-links';
import { fetchInvitations, fetchMembers } from '@/lib/organization';
import { canManageTeam } from '@/lib/organization-vocabulary';
import { fetchMe } from '@/lib/me';

// §41 screen 18 team management — members, pending invitations, and
// (owner/admin only) the invite form. Fetches members, invitations, and the
// caller's role in parallel; a plain member sees everything read-only.
export default async function MembersPage() {
  const [members, invitations, me] = await Promise.all([
    fetchMembers(),
    fetchInvitations(),
    fetchMe(),
  ]);
  const role = me?.role ?? 'member';
  const canManage = canManageTeam(role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/settings"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <DocsLink href={DOCS.organizationAndTeam}>About roles and team members</DocsLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? 'member' : 'members'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MembersList members={members} currentUserId={me?.user.id ?? ''} currentUserRole={role} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
        </CardHeader>
        <CardContent>
          <PendingInvitations invitations={invitations} canManage={canManage} />
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite someone</CardTitle>
          </CardHeader>
          <CardContent>
            <InviteMemberForm userEmail={me?.user.email ?? ''} />
          </CardContent>
        </Card>
      ) : null}

      {role !== 'owner' ? (
        <Card>
          <CardHeader>
            <CardTitle>Leave organization</CardTitle>
          </CardHeader>
          <CardContent>
            <LeaveOrganizationButton />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
