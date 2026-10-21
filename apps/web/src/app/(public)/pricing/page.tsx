import type { Metadata } from 'next';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { DeployzBrand } from '@/components/deployz-brand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const metadata: Metadata = {
  title: 'Pricing',
  description: '$49/month plus $19 for each live customer deployment. No infrastructure resale.',
};

const USAGE_ROWS = [
  { deployments: 'Base only', count: 0, total: '$49' },
  { deployments: '1 deployment', count: 1, total: '$68' },
  { deployments: '5 deployments', count: 5, total: '$144' },
  { deployments: '10 deployments', count: 10, total: '$239' },
  { deployments: '50 deployments', count: 50, total: '$999' },
] as const;

// prefetch={false} on every /sign-in and /sign-up link: those paths live on
// the app hostname and middleware redirects them there, so Next's prefetch
// leaves the marketing origin, follows a cross-origin redirect and fails
// CORS — dead requests and console errors on every marketing page view, for
// a payload that could never have been used.
export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <Link href="/" className="inline-flex">
            <DeployzBrand />
          </Link>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in" prefetch={false}>Sign In</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/sign-up" prefetch={false}>Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Back to home
        </Link>

        <section className="flex flex-col gap-4">
          <Badge variant="secondary" className="w-fit">Pricing</Badge>
          <h1 className="text-3xl font-semibold tracking-tight">
            $49/month + $19 per deployment
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            The base subscription covers your dashboard, GitHub integration and readiness checks.
            Test deployments are not charged. Each customer deployment adds $19/month only while it
            runs for your customer. A failed or disconnected deployment is not charged, and charges
            stop when it is removed.
          </p>
        </section>

        <Separator className="my-8" />

        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Usage examples</h2>
          <Card>
            <CardHeader>
              <CardTitle>What you pay</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deployments</TableHead>
                    <TableHead className="text-right">Monthly total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {USAGE_ROWS.map((row) => (
                    <TableRow key={row.count}>
                      <TableCell>{row.deployments}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{row.total}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>

        <section className="mt-8 rounded-xl border border-dashed px-6 py-8 text-center">
          <p className="text-sm font-medium">
            Your customer pays AWS directly for their infrastructure
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Deployz charges for the dashboard and deployments. AWS charges your customer for the
            resources their deployment uses. You never resell infrastructure.
          </p>
        </section>

        <section className="mt-8 flex flex-col items-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up" prefetch={false}>
              Get Started
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-xs text-muted-foreground">
          Deployz — Deploy your SaaS into customer AWS.
        </div>
      </footer>
    </div>
  );
}
