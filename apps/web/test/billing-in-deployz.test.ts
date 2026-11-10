// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '@/lib/api-client';
import { cancelSubscription, downloadInvoice } from '@/lib/billing-checkout';

// Billing actions that stay inside Deployz: cancelling and saving an invoice.
describe('cancelSubscription', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the API to end the subscription at the end of the period', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ endsAt: '2026-12-10T00:00:00Z' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelSubscription()).resolves.toEqual({ endsAt: '2026-12-10T00:00:00Z' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/billing/cancel');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('shows the message the API gives when the subscription already ends', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'ALREADY_CANCELLING', message: 'Already ending.' } }), {
            status: 409,
          }),
      ),
    );

    await expect(cancelSubscription()).rejects.toMatchObject({ code: 'ALREADY_CANCELLING', message: 'Already ending.' });
  });
});

describe('downloadInvoice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('saves the PDF from the Deployz API without opening a new tab', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.fn(() => 'blob:invoice');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const open = vi.spyOn(window, 'open');
    let saved: { download: string; href: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved = { download: this.download, href: this.href };
    });

    await downloadInvoice('order-1', '2026-00002');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/billing/invoices/order-1/file');
    expect(saved).toEqual({ download: 'invoice-2026-00002.pdf', href: 'blob:invoice' });
    expect(revoke).toHaveBeenCalledWith('blob:invoice');
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the API message while the invoice is being prepared', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INVOICE_NOT_READY', message: 'The invoice is being prepared.' } }), {
            status: 409,
          }),
      ),
    );

    const failure = await downloadInvoice('order-1', '2026-00002').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ code: 'INVOICE_NOT_READY', message: 'The invoice is being prepared.' });
  });
});
