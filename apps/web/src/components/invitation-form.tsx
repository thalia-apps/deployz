'use client';

import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { allowedSizeTiers, type InfrastructureSizeTier } from '@deployz/contracts';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { copyInstallLink } from '@/components/copy-install-link';
import { SizeSelect } from '@/components/size-select';
import { apiUrl } from '@/lib/api-url';
import { errorMessage } from '@/lib/api-client';
import { fetchApplications, type Application } from '@/lib/applications';
import { fetchRegions, regionOptionLabel, type RegionOption } from '@/lib/regions';

// Invite customer — the vendor side of the targeted invitation model
// (Phase 2 API). The invitation names the customer (the route does) and at
// most recommends a Region; the customer makes the final Region choice and
// confirms before any deployment exists. The link's secret token is shown
// exactly once and is never stored in plain text anywhere.

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: string;
  recommendedRegion: string | null;
}

export function InvitationDialog({
  customerId,
  open,
  onOpenChange,
  onCreated,
}: {
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const appId = useId();
  const regionId = useId();
  const sizeId = useId();
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [applicationId, setApplicationId] = useState('');
  const [recommendedRegion, setRecommendedRegion] = useState('');
  const [recommendedSize, setRecommendedSize] = useState<InfrastructureSizeTier | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ url: string; token: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRevealed(null);
    setApplicationId('');
    setRecommendedRegion('');
    setRecommendedSize(null);
    void fetchApplications()
      .then(setApplications)
      .catch(() => setError('Applications could not be loaded. Try again in a moment.'));
    void fetchRegions()
      .then(setRegions)
      .catch(() => {
        // The recommendation is optional; an unavailable list still allows create.
        setRegions([]);
      });
  }, [open]);

  const selectedApplication = (applications ?? []).find((application) => application.id === applicationId);

  // The size starts at the application's recommended size.
  function chooseApplication(id: string): void {
    setApplicationId(id);
    setRecommendedSize((applications ?? []).find((application) => application.id === id)?.defaultSizeProfile ?? null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || applicationId === '') return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiUrl}/api/customers/${encodeURIComponent(customerId)}/invitations`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          applicationId,
          ...(recommendedRegion !== '' ? { recommendedRegion } : {}),
          ...(recommendedSize ? { recommendedSizeProfile: recommendedSize } : {}),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Invitation creation failed (${response.status})`);
      }
      const body = (await response.json()) as { id: string; token: string };
      if (typeof window !== 'undefined') {
        // One shareable URL: the one-time token rides as the URL fragment
        // (never sent to the server; stripped from history after capture).
        setRevealed({ url: `${window.location.origin}/install/${body.id}#${body.token}`, token: body.token });
      }
      onCreated();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        {revealed === null ? (
          <form onSubmit={onSubmit}>
            <DialogHeader>
              <DialogTitle>Invite customer</DialogTitle>
              <DialogDescription>
                Creating an invitation does not deploy anything. Your customer confirms the install.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={appId}>Application</Label>
                <Select value={applicationId} onValueChange={chooseApplication} required>
                  <SelectTrigger id={appId} className="w-full">
                    <SelectValue placeholder="Select an application" />
                  </SelectTrigger>
                  <SelectContent>
                    {(applications ?? []).map((application) => (
                      <SelectItem key={application.id} value={application.id}>
                        {application.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedApplication && recommendedSize ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={sizeId}>Recommended size</Label>
                  <SizeSelect
                    id={sizeId}
                    value={recommendedSize}
                    tiers={allowedSizeTiers(selectedApplication.minimumSizeProfile)}
                    onValueChange={setRecommendedSize}
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor={regionId}>
                  Recommended AWS region <span className="text-muted-foreground">(Optional)</span>
                </Label>
                <Select value={recommendedRegion} onValueChange={setRecommendedRegion}>
                  <SelectTrigger id={regionId} className="w-full">
                    <SelectValue placeholder="No recommendation" />
                  </SelectTrigger>
                  <SelectContent>
                    {regions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {regionOptionLabel(option.value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Your customer will make the final Region selection before deployment.
                </p>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={applicationId === '' || pending} loading={pending}>
                Create invitation
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invitation created</DialogTitle>
              <DialogDescription>
                Send the install link to your customer. The token is shown only once.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <div>
                <Label htmlFor="invitation-link">Install link</Label>
                <div className="mt-2 flex items-center gap-2">
                  <Input id="invitation-link" readOnly value={revealed.url} className="font-mono text-xs" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyInstallLink(revealed.url)}
                  >
                    Copy link
                  </Button>
                </div>
              </div>
              <div>
                <Label htmlFor="invitation-token">One-time token</Label>
                <div className="mt-2 flex items-center gap-2">
                  <Input readOnly value={revealed.token} className="font-mono text-xs" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(revealed.token)
                        .then(() => toast.success('Token copied.'))
                        .catch(() => toast.error("We couldn't copy the token."))
                    }
                  >
                    Copy
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
