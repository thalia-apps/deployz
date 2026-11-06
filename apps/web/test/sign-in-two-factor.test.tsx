// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(),
}));

const authMocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  sendOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));
vi.mock('../src/lib/auth-client', () => ({
  authClient: {
    signIn: { email: authMocks.signInEmail },
    twoFactor: { sendOtp: authMocks.sendOtp, verifyOtp: authMocks.verifyOtp },
  },
}));

const { default: SignInPage } = await import('../src/app/(auth)/sign-in/page');

function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function renderPage(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SignInPage />);
  });
  cleanup = () => act(() => root.unmount());
  return container;
}

async function submitPassword(container: HTMLElement): Promise<void> {
  setValue(container.querySelector<HTMLInputElement>('#email')!, 'ada@example.com');
  setValue(container.querySelector<HTMLInputElement>('#password')!, 'super-secret-1');
  await submit(container.querySelector('form')!);
}

describe('sign-in page with two-factor sign-in', () => {
  it('goes to the dashboard after the password when two-factor sign-in is off', async () => {
    authMocks.signInEmail.mockResolvedValue({ data: { token: 't' }, error: null });
    const container = await renderPage();

    await submitPassword(container);

    expect(authMocks.sendOtp).not.toHaveBeenCalled();
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard');
  });

  it('sends one code, asks for it, and signs in only after the right code', async () => {
    authMocks.signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    authMocks.sendOtp.mockResolvedValue({ data: { status: true }, error: null });
    authMocks.verifyOtp
      .mockResolvedValueOnce({ data: null, error: { message: 'Invalid code' } })
      .mockResolvedValueOnce({ data: { token: 't' }, error: null });
    const container = await renderPage();

    await submitPassword(container);

    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(authMocks.sendOtp).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Enter your sign-in code');
    const code = container.querySelector<HTMLInputElement>('#code')!;

    await act(async () => setValue(code, '000000'));
    await submit(container.querySelector('form')!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid code');
    expect(routerMocks.push).not.toHaveBeenCalled();

    await act(async () => setValue(code, '123456'));
    await submit(container.querySelector('form')!);
    expect(authMocks.verifyOtp).toHaveBeenLastCalledWith({ code: '123456' });
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard');
  });
});
