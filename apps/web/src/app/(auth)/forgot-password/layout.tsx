import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Forgot password',
  description: 'Get a link to reset your Deployz password.',
};

export default function ForgotPasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
