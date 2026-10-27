'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest, errorMessage } from '@/lib/api-client';

// §63 danger zone — deleting an organization is permanent. Typing the exact
// organization name is the explicit confirmation step; there is no bare
// one-click delete. Owner only (enforced by the caller).
export function OrganizationDangerZone({ organizationName }: { organizationName: string }) {
  const router = useRouter();
  const [confirmName, setConfirmName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canDelete = confirmName.trim() === organizationName;

  async function handleDelete(): Promise<void> {
    if (!canDelete) return;
    setPending(true);
    setError(null);
    try {
      await apiRequest('/api/organization', { method: 'DELETE', body: { confirmName } });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Deleting the organization removes it and all its data. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmOrgName">
            Type <span className="font-semibold">{organizationName}</span> to confirm
          </Label>
          <Input
            id="confirmOrgName"
            data-testid="delete-organization-confirm"
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <Button
            type="button"
            variant="destructive"
            disabled={!canDelete}
            loading={pending}
            loadingText="Deleting organization…"
            onClick={handleDelete}
            data-testid="delete-organization-submit"
          >
            Delete organization
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
