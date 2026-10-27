'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { apiRequest, errorMessage } from '@/lib/api-client';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  type MemberInfo,
  type OrgRole,
} from '@/lib/organization-vocabulary';

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

// Who may change or remove a given member, per the permission matrix: the
// owner can act on anyone but themselves, an admin only on plain members,
// and nobody acts on themselves or on the owner.
function canActOn(currentUserRole: OrgRole, targetRole: OrgRole, isSelf: boolean): boolean {
  if (isSelf || targetRole === 'owner') return false;
  if (currentUserRole === 'owner') return true;
  return currentUserRole === 'admin' && targetRole === 'member';
}

interface MembersListProps {
  members: MemberInfo[];
  currentUserId: string;
  currentUserRole: OrgRole;
}

// §41 screen 18 team management — the member roster. Row actions (role
// change, remove, transfer ownership) only render for people who may use
// them; everyone else sees a read-only list.
export function MembersList({ members, currentUserId, currentUserRole }: MembersListProps) {
  return (
    <div className="flex flex-col divide-y divide-border">
      {members.map((member) => (
        <MemberRow
          key={member.id}
          member={member}
          isSelf={member.userId === currentUserId}
          currentUserRole={currentUserRole}
        />
      ))}
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  currentUserRole,
}: {
  member: MemberInfo;
  isSelf: boolean;
  currentUserRole: OrgRole;
}) {
  const router = useRouter();
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [removeStep, setRemoveStep] = useState<'idle' | 'confirm'>('idle');
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [transferStep, setTransferStep] = useState<'idle' | 'confirm'>('idle');
  const [transferPending, setTransferPending] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const canAct = canActOn(currentUserRole, member.role, isSelf);
  const canTransfer = currentUserRole === 'owner' && !isSelf && member.role !== 'owner';
  const rowBusy = roleSaving || removePending || transferPending;

  async function handleRoleChange(role: 'admin' | 'member'): Promise<void> {
    setRoleSaving(true);
    setRoleError(null);
    try {
      await apiRequest(`/api/organization/members/${member.id}`, { method: 'PATCH', body: { role } });
      router.refresh();
    } catch (err) {
      setRoleError(errorMessage(err));
    } finally {
      setRoleSaving(false);
    }
  }

  async function handleRemove(): Promise<void> {
    setRemovePending(true);
    setRemoveError(null);
    try {
      await apiRequest(`/api/organization/members/${member.id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setRemoveError(errorMessage(err));
      setRemoveStep('idle');
      setRemovePending(false);
    }
  }

  async function handleTransfer(): Promise<void> {
    setTransferPending(true);
    setTransferError(null);
    try {
      await apiRequest('/api/organization/transfer-ownership', {
        method: 'POST',
        body: { memberId: member.id },
      });
      router.refresh();
    } catch (err) {
      setTransferError(errorMessage(err));
      setTransferStep('idle');
      setTransferPending(false);
    }
  }

  return (
    <div data-testid="member-row" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar size="sm">
            <AvatarFallback>{initials(member.name) || '?'}</AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {member.name}
              {isSelf ? <span className="text-xs text-muted-foreground">(You)</span> : null}
            </span>
            <span className="text-xs text-muted-foreground">{member.email}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canAct ? (
            <div className="flex items-center gap-1.5">
              <select
                data-testid="member-role-select"
                aria-label={`Role for ${member.name}`}
                value={member.role === 'owner' ? 'admin' : member.role}
                disabled={rowBusy}
                aria-busy={roleSaving || undefined}
                onChange={(event) => handleRoleChange(event.target.value as 'admin' | 'member')}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              {roleSaving ? <Spinner aria-label="Saving role" className="size-3.5" /> : null}
            </div>
          ) : (
            <Badge variant="secondary">{ROLE_LABELS[member.role]}</Badge>
          )}
          {canAct ? (
            removeStep === 'idle' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rowBusy}
                data-testid="member-remove"
                onClick={() => setRemoveStep('confirm')}
              >
                Remove
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={roleSaving || transferPending}
                  loading={removePending}
                  loadingText="Removing member…"
                  onClick={handleRemove}
                  data-testid="member-remove-confirm"
                >
                  Confirm remove
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={removePending}
                  onClick={() => setRemoveStep('idle')}
                >
                  Cancel
                </Button>
              </div>
            )
          ) : null}
          {canTransfer ? (
            transferStep === 'idle' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={rowBusy}
                data-testid="transfer-ownership"
                onClick={() => setTransferStep('confirm')}
              >
                Transfer ownership
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={roleSaving || removePending}
                  loading={transferPending}
                  loadingText="Transferring ownership…"
                  onClick={handleTransfer}
                  data-testid="transfer-ownership-confirm"
                >
                  {`Make ${member.name} the owner`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={transferPending}
                  onClick={() => setTransferStep('idle')}
                >
                  Cancel
                </Button>
              </div>
            )
          ) : null}
        </div>
      </div>
      {roleError ? (
        <p role="alert" className="text-sm text-destructive">
          {roleError}
        </p>
      ) : null}
      {removeError ? (
        <p role="alert" className="text-sm text-destructive">
          {removeError}
        </p>
      ) : null}
      {transferError ? (
        <p role="alert" className="text-sm text-destructive">
          {transferError}
        </p>
      ) : null}
    </div>
  );
}

// §41 screen 18 — leaving is available to anyone but the owner (who must
// transfer ownership first, per the API's LAST_OWNER guard). A short confirm
// step replaces a bare one-click leave.
export function LeaveOrganizationButton() {
  const router = useRouter();
  const [step, setStep] = useState<'idle' | 'confirm'>('idle');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLeave(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await apiRequest('/api/organization/leave', { method: 'POST' });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setStep('idle');
      setPending(false);
    }
  }

  if (step === 'idle') {
    return (
      <Button
        type="button"
        variant="outline"
        data-testid="leave-organization"
        onClick={() => setStep('confirm')}
      >
        Leave organization
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        You will lose access to this organization&apos;s applications and deployments.
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="destructive"
          loading={pending}
          loadingText="Leaving organization…"
          onClick={handleLeave}
          data-testid="leave-organization-confirm"
        >
          Confirm leave
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setStep('idle')}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
