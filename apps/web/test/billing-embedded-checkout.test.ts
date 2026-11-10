// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openEmbeddedCheckout } from '@/lib/billing-checkout';

type Listener = (event: { preventDefault: () => void }) => void;

const embed = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('@polar-sh/checkout/embed', () => ({ PolarEmbedCheckout: { create: embed.create } }));

// The subscribe checkout opens on top of the page and tells it how it ended.
describe('openEmbeddedCheckout', () => {
  const listeners: Record<string, Listener> = {};
  const close = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    close.mockClear();
    embed.create.mockReset();
    embed.create.mockResolvedValue({
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
      close,
    });
  });

  it('opens the checkout URL with the theme and waits for the outcome', async () => {
    const outcome = openEmbeddedCheckout('https://sandbox.polar.sh/checkout/x', 'dark');
    await vi.waitFor(() => expect(listeners.success).toBeDefined());

    expect(embed.create).toHaveBeenCalledWith('https://sandbox.polar.sh/checkout/x', { theme: 'dark' });
    listeners.close!({ preventDefault: vi.fn() });
    expect(await outcome).toBe('closed');
  });

  it('treats a close after the order was confirmed as paid, because the payment is processing', async () => {
    const outcome = openEmbeddedCheckout('https://sandbox.polar.sh/checkout/x');
    await vi.waitFor(() => expect(listeners.confirmed).toBeDefined());

    listeners.confirmed!({ preventDefault: vi.fn() });
    listeners.close!({ preventDefault: vi.fn() });

    expect(await outcome).toBe('paid');
  });

  it('stays on the page and closes the overlay when the payment succeeds', async () => {
    const outcome = openEmbeddedCheckout('https://sandbox.polar.sh/checkout/x');
    await vi.waitFor(() => expect(listeners.success).toBeDefined());
    const preventDefault = vi.fn();

    listeners.success!({ preventDefault });

    expect(await outcome).toBe('paid');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects when the embed cannot be created', async () => {
    embed.create.mockRejectedValue(new Error('blocked'));
    await expect(openEmbeddedCheckout('https://sandbox.polar.sh/checkout/x')).rejects.toThrow('blocked');
  });
});
