import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { OnboardingStep } from '@/lib/home-state';
import { cn } from '@/lib/utils';

// The homepage's onboarding checklist. Presentational only: the caller
// derives each step's state from real organization data. Only the current
// step shows its detail and its one action. Every step carries a worded
// status, so the progress never depends on colour alone.
export function SetupProgress({ steps }: { steps: readonly OnboardingStep[] }) {
  return (
    <ol aria-label="Setup progress" data-testid="setup-progress" className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const complete = step.state === 'complete';
        const current = step.state === 'current';
        return (
          <li
            key={step.label}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm',
              current ? 'border-foreground/20 bg-accent' : 'border-transparent',
              complete || current ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                  complete && 'border-transparent bg-primary text-primary-foreground',
                  current && 'border-primary text-primary',
                  !complete && !current && 'border-border text-muted-foreground',
                )}
              >
                {complete ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="font-medium">{step.label}</span>
              <Badge variant={current ? 'secondary' : 'ghost'} className="ml-auto shrink-0">
                {complete ? 'Done' : current ? 'Current' : 'Pending'}
              </Badge>
            </div>
            {current && (step.detail !== null || step.action !== null) ? (
              <div className="flex flex-col items-start gap-3 pl-9">
                {step.detail === null ? null : <p className="text-muted-foreground">{step.detail}</p>}
                {step.action === null ? null : (
                  <Button asChild size="sm">
                    <Link href={step.action.href}>
                      {step.action.label}
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
