'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrganizationInfo } from '@/lib/organization-vocabulary';

import { apiUrl } from '@/lib/api-url';

// §41 screen 18 — organization settings form. Submits PATCH /api/organization
// for real (previously had no handler at all). §65: plain confirmation text,
// no raw API vocabulary.
export function OrganizationForm({ organization }: { organization: OrganizationInfo }) {
  const router = useRouter();
  const [name, setName] = useState(organization.name);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus('saving');
    try {
      const response = await fetch(`${apiUrl}/api/organization`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`Update failed (${response.status})`);
      const updated = (await response.json()) as OrganizationInfo;
      setName(updated.name);
      setStatus('saved');
      router.refresh();
    } catch {
      setStatus('error');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="orgName">Organization name</Label>
        <Input
          id="orgName"
          name="orgName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={name.trim().length === 0}
          loading={status === 'saving'}
          loadingText="Saving organization…"
        >
          Update Organization
        </Button>
        {status === 'saved' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Saved.
          </p>
        ) : null}
        {status === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t save. Try again.
          </p>
        ) : null}
      </div>
    </form>
  );
}
