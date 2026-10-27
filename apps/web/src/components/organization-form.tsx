'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest, errorMessage } from '@/lib/api-client';
import type { OrganizationInfo } from '@/lib/organization-vocabulary';

// §41 screen 18 — organization settings form. Submits PATCH /api/organization
// for real (previously had no handler at all). §65: plain confirmation text,
// no raw API vocabulary.
export function OrganizationForm({ organization }: { organization: OrganizationInfo }) {
  const router = useRouter();
  const [name, setName] = useState(organization.name);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus('saving');
    try {
      const updated = await apiRequest<OrganizationInfo>('/api/organization', {
        method: 'PATCH',
        body: { name },
      });
      setName(updated.name);
      setStatus('saved');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save. Try again."));
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
          maxLength={80}
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
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
