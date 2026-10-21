// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CustomDomainStatus, CustomDomainView } from '../src/lib/domains';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A vendor must be able to remove a custom domain in every state except
// 'removing', including 'pending' (certificate still being requested) and
// 'error' (for example a certificate ACM refused).

const domainMocks = vi.hoisted(() => ({ fetchDomainAccess: vi.fn() }));

vi.mock('../src/lib/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/domains')>();
  return { ...actual, fetchDomainAccess: domainMocks.fetchDomainAccess };
});

const { CustomDomainCard } = await import('../src/components/custom-domain-card');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderCard(
  status: CustomDomainStatus,
  error: string | null = null,
  canManage = true,
): Promise<HTMLElement> {
  const domain: CustomDomainView = { hostname: 'example.com', status, records: [], error, url: null };
  domainMocks.fetchDomainAccess.mockResolvedValue({ canManage, domain });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CustomDomainCard deploymentId="dep-1" installLinkId={null} initialDomain={canManage ? null : domain} />);
  });
  return container;
}

function removeButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => b.textContent === 'Remove domain');
}

function buttonLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

describe('CustomDomainCard terminal error', () => {
  it.each(['CERTIFICATE_FAILED', 'CONFIGURE_FAILED'])(
    'offers no retry for %s, only removing the domain and adding it again',
    async (error) => {
      const el = await renderCard('error', error);
      expect(buttonLabels(el)).toEqual(['Remove domain']);
      expect(el.textContent).toContain('Remove this domain, then add it again to start over.');
    },
  );

  it('points a viewer who cannot manage the domain to the software provider', async () => {
    const el = await renderCard('error', 'CERTIFICATE_FAILED', false);
    expect(buttonLabels(el)).toEqual([]);
    expect(el.textContent).toContain('Ask your software provider to remove this domain and add it again.');
  });

  it('still lets a progressing domain be checked', async () => {
    const el = await renderCard('waiting_for_dns');
    expect(buttonLabels(el)).toContain('Check now');
  });
});

describe('CustomDomainCard Remove availability', () => {
  it.each(['pending', 'waiting_for_dns', 'configuring', 'active', 'error'] as const)(
    'offers an enabled Remove button when the domain is %s',
    async (status) => {
      const el = await renderCard(status);
      const button = removeButton(el);
      expect(button).toBeDefined();
      expect(button!.disabled).toBe(false);
    },
  );

  it('disables Remove while the domain is being removed', async () => {
    const el = await renderCard('removing');
    expect(removeButton(el)!.disabled).toBe(true);
  });

  it('explains a failed certificate in plain language', async () => {
    const el = await renderCard('error', 'CERTIFICATE_FAILED');
    expect(el.textContent).toContain("The HTTPS certificate couldn't be issued");
    expect(el.textContent).not.toMatch(/ACM|FAILED/);
  });
});
