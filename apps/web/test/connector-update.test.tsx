// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VendorDeploymentStatus } from '@deployz/contracts';

import { ConnectorUpdateAlert } from '../src/components/connector-update-alert';
import { ExistingConnectorUpdate } from '../src/components/existing-connector-update';
import { runningReleaseDisplay } from '../src/lib/release-version';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const connector = (
  overrides: Partial<VendorDeploymentStatus['connector']> = {},
): VendorDeploymentStatus['connector'] => ({
  upgradeRequired: false,
  reason: null,
  updateAvailable: false,
  updateUrl: null,
  updateTemplateUrl: null,
  installedBuildId: null,
  publishedBuildId: null,
  stackState: 'UNKNOWN',
  observedAt: null,
  ...overrides,
});

describe('ConnectorUpdateAlert', () => {
  it('renders nothing when no update is on offer', () => {
    const view = render(<ConnectorUpdateAlert connector={connector()} customerName="Acme" />);
    expect(view.textContent).toBe('');
  });

  it('hides the update offer while the connector is offline', () => {
    const view = render(
      <ConnectorUpdateAlert connector={connector({ updateAvailable: true })} customerName="Acme" offline />,
    );
    expect(view.textContent).toBe('');
  });

  it('says the update is required to verify releases, with the stack link and the keep-values instruction', () => {
    const view = render(
      <ConnectorUpdateAlert
        connector={connector({
          upgradeRequired: true,
          reason: 'RELEASE_EVIDENCE_MISSING',
          updateAvailable: true,
          updateUrl: 'https://us-east-1.console.aws.amazon.com/cloudformation/home#/stacks',
          updateTemplateUrl: 'https://tpl.example/versions/abc/bootstrap-template-v1.json',
        })}
        customerName="Acme"
      />,
    );
    expect(view.textContent).toContain('Connector update required to verify releases');
    expect(view.textContent).toContain('Use existing value');
    expect(view.textContent).toContain('RelayCredential');
    expect(view.textContent).toContain('https://tpl.example/versions/abc/bootstrap-template-v1.json');
    expect(view.querySelector('a')?.getAttribute('href')).toBe(
      'https://us-east-1.console.aws.amazon.com/cloudformation/home#/stacks',
    );
  });

  it('offers a plain update when a newer connector build is published', () => {
    const view = render(
      <ConnectorUpdateAlert connector={connector({ updateAvailable: true })} customerName="Acme" />,
    );
    expect(view.textContent).toContain('Connector update available');
    expect(view.textContent).not.toContain('required');
  });

  it('says the update is in progress while the connector stack updates', () => {
    const view = render(
      <ConnectorUpdateAlert connector={connector({ stackState: 'UPDATING', updateAvailable: true })} customerName="Acme" />,
    );
    expect(view.textContent).toContain('Connector update in progress');
    expect(view.textContent).not.toContain('Replace existing template');
  });

  it('says the update rolled back and offers it again', () => {
    const view = render(
      <ConnectorUpdateAlert
        connector={connector({ stackState: 'ROLLED_BACK', updateAvailable: true, updateUrl: 'https://console.example/stacks' })}
        customerName="Acme"
      />,
    );
    expect(view.textContent).toContain('Connector update rolled back');
    expect(view.textContent).toContain('Replace existing template');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://console.example/stacks');
  });

  it('says the update failed, without raw CloudFormation states', () => {
    const view = render(<ConnectorUpdateAlert connector={connector({ stackState: 'FAILED' })} customerName="Acme" />);
    expect(view.textContent).toContain('Connector update failed');
    expect(view.textContent).not.toMatch(/[A-Z]+_[A-Z_]+/);
  });
});

describe('ExistingConnectorUpdate', () => {
  it('tells the customer to update the existing stack with the new credential and code', () => {
    const view = render(
      <ExistingConnectorUpdate
        installLinkId="link-1"
        update={{
          stackName: 'deployz-acme-1',
          consoleUrl: 'https://console.example/stacks',
          templateUrl: 'https://tpl.example/t.json',
          enrollmentCode: 'code-123',
          relayCredential: 'cred-456',
          controlPlaneUrl: 'https://api.example',
        }}
      />,
    );
    expect(view.textContent).toContain('Update the connector stack. Do not create a new one.');
    expect(view.textContent).toContain('deployz-acme-1');
    expect(view.textContent).toContain('code-123');
    expect(view.textContent).toContain('cred-456');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://console.example/stacks');
  });
});

describe('runningReleaseDisplay', () => {
  it('shows the release as running only when confirmed', () => {
    expect(runningReleaseDisplay('1.2.0', true, true)).toEqual({ text: 'v1.2.0', note: null });
    expect(runningReleaseDisplay('1.2.0', false, true)).toEqual({ text: 'Last confirmed v1.2.0', note: 'Verifying…' });
    expect(runningReleaseDisplay('1.2.0', false, false)).toEqual({ text: 'Last confirmed v1.2.0', note: null });
    expect(runningReleaseDisplay('1.2.0', true, false)).toEqual({ text: 'Last confirmed v1.2.0', note: null });
    expect(runningReleaseDisplay(null, false, true)).toEqual({ text: 'Not deployed yet', note: null });
  });
});
