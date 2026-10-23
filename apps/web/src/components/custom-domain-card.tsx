'use client';

import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api-client';
import {
  checkDomainByDeployLink,
  fetchDomainByDeployLink,
} from '@/lib/deploy-link-flow';
import { DOCS } from '@/lib/docs-links';
import {
  addDomain,
  checkDomain,
  checkDomainByLink,
  DOMAIN_STATUS_LABEL,
  domainErrorCopy,
  fetchDomainAccess,
  fetchDomainByLink,
  removeDomain,
  type CustomDomainStatus,
  type CustomDomainView,
  type DnsRecordView,
} from '@/lib/domains';

/** How often to re-check a domain that hasn't settled into 'active' (spec). */
const DOMAIN_POLL_MS = 5000;

const DNS_RECORD_PURPOSE_LABEL: Record<DnsRecordView['purpose'], string> = {
  verification: 'Verify ownership',
  routing: 'Route traffic',
};

type Panel = 'none' | 'add' | 'remove';

/**
 * §65 custom-domains card. Renders in one of two modes:
 *  - manage (vendor dashboard, `deploymentId` set and the session can read
 *    it): full lifecycle — add, check, remove.
 *  - customer (install-link page, or a dashboard session without access to
 *    this deployment): read-only plus "Check now", scoped to `installLinkId`.
 *
 * No modal anywhere — every action opens an inline panel in place, matching
 * the house pattern (`DisconnectPanel`, `InstallLinkCard`).
 */
export function CustomDomainCard(props: {
  deploymentId: string | null;
  installLinkId: string | null;
  initialDomain: CustomDomainView | null;
  /** Set on the /deploy page: link-scoped calls resolve through the deploy
   *  link (token header) instead of the install link. */
  deployLink?: { publicId: string; token: string } | null;
}) {
  const { deploymentId, installLinkId, initialDomain, deployLink } = props;

  const [ready, setReady] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [domain, setDomain] = useState<CustomDomainView | null>(initialDomain);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // Mode detection. `fetchDomain` collapses "no domain yet" and "no access"
  // into the same `null`, which can't tell a vendor with an empty domain
  // apart from a customer without dashboard access — `fetchDomainAccess`
  // keeps the two apart via its `canManage` flag, and already resolves
  // (doesn't throw) for the UNAUTHORIZED/FORBIDDEN/NOT_FOUND "no access"
  // cases. So anything that reaches this `catch` is a genuine failure
  // (network down, a 5xx, an unrecognised error code) — surface it instead
  // of silently pretending this is a customer view, which would hide a real
  // outage behind an empty-looking card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (deploymentId) {
        try {
          const access = await fetchDomainAccess(deploymentId);
          if (cancelled) return;
          if (access.canManage) {
            setCanManage(true);
            setDomain(access.domain);
            setLoadError(null);
            setReady(true);
            return;
          }
        } catch (caught) {
          if (cancelled) return;
          setLoadError(errorMessage(caught));
          setCanManage(false);
          setDomain(initialDomain);
          setReady(true);
          return;
        }
      }
      if (cancelled) return;
      setCanManage(false);
      setDomain(initialDomain);
      setLoadError(null);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [deploymentId, initialDomain]);

  const status = domain?.status ?? null;

  // Poll while a domain exists and hasn't settled into 'active' or the
  // terminal 'error' (nothing changes it until it is removed).
  useEffect(() => {
    if (!ready || status === null || status === 'active' || status === 'error') return;
    let cancelled = false;
    const timer = setInterval(() => {
      const refresh =
        canManage && deploymentId
          ? fetchDomainAccess(deploymentId).then((access) => access.domain)
          : installLinkId
            ? fetchDomainByLink(installLinkId)
            : deployLink
              ? fetchDomainByDeployLink(deployLink.publicId, deployLink.token)
              : null;
      if (!refresh) return;
      void refresh
        .then((next) => {
          if (cancelled) return;
          setDomain(next);
        })
        .catch(() => {
          /* transient failure — the next tick tries again */
        });
    }, DOMAIN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ready, status, canManage, deploymentId, installLinkId]);

  async function handleCheck(): Promise<void> {
    setChecking(true);
    setCheckError(null);
    try {
      const next =
        canManage && deploymentId
          ? await checkDomain(deploymentId)
          : installLinkId
            ? await checkDomainByLink(installLinkId)
            : deployLink
              ? await checkDomainByDeployLink(deployLink.publicId, deployLink.token)
              : null;
      if (next) setDomain(next);
    } catch (caught) {
      setCheckError(errorMessage(caught));
    } finally {
      setChecking(false);
    }
  }

  function toggleRemovePanel(): void {
    setPanel((current) => (current === 'remove' ? 'none' : 'remove'));
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      <Card data-testid="custom-domain-card" className="max-w-2xl">
        <CardContent className="flex flex-col gap-3 py-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">Custom domain</h3>
            {domain ? <StatusLine status={domain.status} /> : null}
          </div>

          {!ready ? (
            <p className="text-sm text-muted-foreground">Loading domain settings…</p>
          ) : null}

          {ready && loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {loadError}
            </p>
          ) : null}

          {ready && domain === null ? (
            canManage ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Use your customer&apos;s own domain for this deployment.
                </p>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setPanel((current) => (current === 'add' ? 'none' : 'add'))}
                  >
                    Set up custom domain
                  </Button>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    You&apos;ll need access to the domain&apos;s DNS settings.
                  </p>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No custom domain yet.
              </p>
            )
          ) : null}

          {ready && domain !== null ? (
            <DomainStatusBody
              domain={domain}
              canManage={canManage}
              checking={checking}
              checkError={checkError}
              recordsOpen={recordsOpen}
              onToggleRecords={() => setRecordsOpen((open) => !open)}
              onCheck={handleCheck}
              onOpenRemove={toggleRemovePanel}
            />
          ) : null}

          {ready && canManage ? (
            <DocsLink href={DOCS.customDomains}>How custom domains work</DocsLink>
          ) : ready && domain !== null ? (
            <DocsLink href={DOCS.customerDomainDns}>How to create the DNS records</DocsLink>
          ) : null}
        </CardContent>
      </Card>

      {panel === 'add' && deploymentId ? (
        <AddDomainPanel
          onCancel={() => setPanel('none')}
          onAdded={(next) => {
            setDomain(next);
            setPanel('none');
          }}
          submit={(hostname) => addDomain(deploymentId, hostname)}
        />
      ) : null}

      {panel === 'remove' && deploymentId && domain ? (
        <RemoveDomainPanel
          hostname={domain.hostname}
          onCancel={() => setPanel('none')}
          onRemoved={(next) => {
            setDomain(next);
            setPanel('none');
          }}
          submit={() => removeDomain(deploymentId)}
        />
      ) : null}
    </div>
  );
}

function StatusLine({ status }: { status: CustomDomainStatus }) {
  const spinning = status === 'pending' || status === 'configuring' || status === 'removing';
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      {spinning ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
      {DOMAIN_STATUS_LABEL[status]}
    </span>
  );
}

function DomainStatusBody({
  domain,
  canManage,
  checking,
  checkError,
  recordsOpen,
  onToggleRecords,
  onCheck,
  onOpenRemove,
}: {
  domain: CustomDomainView;
  canManage: boolean;
  checking: boolean;
  checkError: string | null;
  recordsOpen: boolean;
  onToggleRecords: () => void;
  onCheck: () => void;
  onOpenRemove: () => void;
}) {
  switch (domain.status) {
    case 'pending':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            Requesting a certificate for this domain…
          </p>
          {canManage ? (
            <div>
              <Button type="button" size="sm" variant="destructive" onClick={onOpenRemove}>
                Remove domain
              </Button>
            </div>
          ) : null}
        </>
      );

    case 'waiting_for_dns':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            Add these DNS records at your DNS provider. Deployz will automatically continue once
            they&apos;re detected.
          </p>
          <DomainProgressNotice code={domain.error} />
          <DnsRecordsList records={domain.records} />
          <p className="text-xs text-muted-foreground">DNS changes can take some time to appear.</p>
          <CheckAndRemoveRow
            canManage={canManage}
            checking={checking}
            checkLabel="Check now"
            checkError={checkError}
            onCheck={onCheck}
            onOpenRemove={onOpenRemove}
          />
        </>
      );

    case 'configuring':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            Domain verified. Deployz is configuring HTTPS.
          </p>
          <DomainProgressNotice code={domain.error} />
          <div className="flex flex-col gap-2">
            <Button type="button" size="sm" variant="ghost" className="self-start" onClick={onToggleRecords}>
              View DNS records
            </Button>
            {recordsOpen ? <DnsRecordsList records={domain.records} /> : null}
          </div>
          <CheckAndRemoveRow
            canManage={canManage}
            checking={checking}
            checkLabel="Check now"
            checkError={checkError}
            onCheck={onCheck}
            onOpenRemove={onOpenRemove}
          />
        </>
      );

    case 'active':
      return (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">Available securely at:</p>
            <a
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              https://{domain.hostname}
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer">
                Open domain
                <ExternalLink aria-hidden className="size-3.5" />
              </a>
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onToggleRecords}>
              View DNS records
            </Button>
            {canManage ? (
              <Button type="button" size="sm" variant="destructive" onClick={onOpenRemove}>
                Remove domain
              </Button>
            ) : null}
          </div>
          {recordsOpen ? <DnsRecordsList records={domain.records} /> : null}
        </>
      );

    case 'error': {
      const copy = domainErrorCopy(domain.error);
      return (
        <>
          {copy ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5">
              <p className="text-sm font-medium text-destructive">{copy.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{copy.body}</p>
            </div>
          ) : null}
          <DnsRecordsList records={domain.records} />
          {/* Deployz does not retry a domain in this state. Only removing it
              and adding it again starts a new attempt. */}
          <p className="text-sm text-muted-foreground">
            {canManage
              ? 'Remove this domain, then add it again to start over.'
              : 'Ask your software provider to remove this domain and add it again.'}
          </p>
          {canManage ? (
            <div>
              <Button type="button" size="sm" variant="destructive" onClick={onOpenRemove}>
                Remove domain
              </Button>
            </div>
          ) : null}
        </>
      );
    }

    case 'removing':
      return (
        <>
          <p className="text-sm text-muted-foreground">
            This domain is being removed. It will stop routing once removal finishes.
          </p>
          <CheckAndRemoveRow
            canManage={canManage}
            checking={checking}
            checkLabel="Check now"
            checkError={checkError}
            onCheck={onCheck}
            onOpenRemove={onOpenRemove}
            disabled
          />
        </>
      );

    default:
      return null;
  }
}

function CheckAndRemoveRow({
  canManage,
  checking,
  checkLabel,
  checkError,
  onCheck,
  onOpenRemove,
  disabled = false,
}: {
  canManage: boolean;
  checking: boolean;
  checkLabel: string;
  checkError: string | null;
  onCheck: () => void;
  onOpenRemove: () => void;
  /** Forces both actions off — used for the 'removing' state, which still
   *  shows the row (so the layout doesn't jump) but nothing in it is
   *  actionable while removal is in flight (spec: "actions disabled"). */
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        loading={checking}
        loadingText="Checking domain…"
        onClick={onCheck}
      >
        {checkLabel}
      </Button>
      {canManage ? (
        <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={onOpenRemove}>
          Remove domain
        </Button>
      ) : null}
      {checkError ? (
        <p role="alert" className="text-sm text-destructive">
          {checkError}
        </p>
      ) : null}
    </div>
  );
}

/** The latest check's diagnosis while a domain is still progressing.
 *  `waiting_for_dns` and `configuring` both record a `lastError` without
 *  leaving their status, so without this the specific reason — which record
 *  is missing or wrong — never reaches the customer. Neutral styling, not
 *  the `error` state's destructive box: a record that has not propagated yet
 *  is expected, not a failure. */
function DomainProgressNotice({ code }: { code: string | null }) {
  const copy = domainErrorCopy(code);
  if (!copy) return null;
  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
      <p className="text-sm font-medium">{copy.title}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{copy.body}</p>
    </div>
  );
}

function DnsRecordsList({ records }: { records: DnsRecordView[] }) {
  return (
    <div className="flex flex-col gap-3">
      {records.map((record) => (
        <DnsRecordRow key={record.purpose} record={record} />
      ))}
    </div>
  );
}

/**
 * One expected DNS record. Name/Value use the exact copy-button pattern from
 * `InstallLinkCard` (deployments/[id]/page.tsx) — a monospace, horizontally
 * scrollable `<code>` block so long values are never truncated, plus a
 * "Copy"/"Copied" button.
 */
function DnsRecordRow({ record }: { record: DnsRecordView }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">{DNS_RECORD_PURPOSE_LABEL[record.purpose]}</p>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Type</span>
        <p className="text-sm">{record.type}</p>
      </div>
      <CopyableField label="Name" value={record.name} />
      <CopyableField label="Value" value={record.value} />
    </div>
  );
}

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, insecure context); the value
      // is still selectable in the code block below.
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="block flex-1 overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function AddDomainPanel({
  onAdded,
  onCancel,
  submit,
}: {
  onAdded: (domain: CustomDomainView) => void;
  onCancel: () => void;
  submit: (hostname: string) => Promise<CustomDomainView>;
}) {
  const [hostname, setHostname] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(): Promise<void> {
    const trimmed = hostname.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      const domain = await submit(trimmed);
      onAdded(domain);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="add-domain-panel">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium">Set up custom domain</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="custom-domain-hostname">Domain</Label>
          <Input
            id="custom-domain-hostname"
            placeholder="app.example.com"
            value={hostname}
            disabled={pending}
            onChange={(event) => setHostname(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Enter a subdomain you control.</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!hostname.trim()}
            loading={pending}
            loadingText="Adding domain…"
            onClick={onSubmit}
          >
            Add domain
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RemoveDomainPanel({
  hostname,
  onRemoved,
  onCancel,
  submit,
}: {
  hostname: string;
  onRemoved: (domain: CustomDomainView | null) => void;
  onCancel: () => void;
  submit: () => Promise<CustomDomainView | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const domain = await submit();
      onRemoved(domain);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="remove-domain-panel" className="border-destructive/40">
      <CardContent className="flex flex-col gap-3 py-4">
        <p className="text-sm font-medium text-destructive">Remove custom domain?</p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{hostname}</span> will stop routing to
          this deployment. Your DNS records will not be deleted automatically.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            loading={pending}
            loadingText="Removing domain…"
            onClick={onConfirm}
          >
            Remove domain
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
