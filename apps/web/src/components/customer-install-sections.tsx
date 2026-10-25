import type { DeploymentPlan } from '@deployz/contracts';
import { ChevronDown, Database, HardDrive, ListChecks, Server, ShieldCheck, type LucideIcon } from 'lucide-react';

import { AwsResourcesTable } from '@/components/aws-resources-table';
import { BeforeYouDeploySection } from '@/components/before-you-deploy-section';
import { DocsLink } from '@/components/docs-link';
import { EnvVarsTable } from '@/components/env-vars-table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  buildResourceCategories,
  retentionSummary,
  type ResourceCategory,
  type ResourceCategorySummary,
} from '@/lib/customer-install-resources';
import { DOCS } from '@/lib/docs-links';
import { formatMonthlyRange } from '@/lib/footprint';

const CATEGORY_ICON: Record<ResourceCategory, LucideIcon> = {
  application: Server,
  database: Database,
  storage: HardDrive,
  messaging: ListChecks,
  network_security: ShieldCheck,
};

/** Resource names shown on a category card before "+N more". */
const CATEGORY_NAME_LIMIT = 2;

/**
 * The pre-launch review surface for the customer install page, in reading
 * order: the estimated AWS cost, a compact summary of what will be deployed
 * (the complete AWS resource table stays one click away under "View AWS
 * resources"), environment variables when any exist, and the data and
 * retention facts.
 *
 * The vendor-facing CustomerInstallReview is untouched; this component
 * is the customer install page's own one-section assembler and never
 * shares that composition.
 */
export function CustomerInstallSections({
  plan,
  securityHref,
  envVarInputs,
}: {
  plan: DeploymentPlan | null;
  securityHref?: string;
  /** Read-only inputs the customer page already receives — never renders values. */
  envVarInputs?: ReadonlyArray<{
    key: string;
    required: boolean;
    secret: boolean;
    classification?: string;
    purpose?: string;
    label?: string;
  }>;
}) {
  const categories = buildResourceCategories(plan);
  return (
    <div className="flex flex-col gap-8" data-testid="customer-install-sections">
      {categories.length > 0 ? (
        <>
          <CostEstimate plan={plan} />
          <section aria-labelledby="aws-resources" className="flex flex-col gap-4">
            <h2 id="aws-resources" className="text-base font-semibold">
              What will be deployed
            </h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="aws-resource-categories">
              {categories.map((category) => (
                <CategoryItem key={category.category} summary={category} />
              ))}
            </ul>
            <Collapsible className="flex flex-col">
              <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
                View AWS resources
                <ChevronDown aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <AwsResourcesTable plan={plan} />
              </CollapsibleContent>
            </Collapsible>
            <DocsLink href={DOCS.customerWhatRuns}>What runs in your AWS account</DocsLink>
          </section>
        </>
      ) : null}
      <EnvVarsTable inputs={envVarInputs ?? []} />
      <BeforeYouDeploySection
        retention={retentionSummary(plan)}
        {...(securityHref ? { securityHref } : {})}
      />
    </div>
  );
}

function CostEstimate({ plan }: { plan: DeploymentPlan | null }) {
  const totalRange = formatMonthlyRange(
    plan?.costEstimate?.monthlyMin ?? null,
    plan?.costEstimate?.monthlyMax ?? null,
  );
  const estimateIncomplete = plan?.costEstimate ? !plan.costEstimate.complete : false;
  return (
    <section
      aria-labelledby="install-cost"
      className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-4"
      data-testid="aws-resources-total"
    >
      <h2 id="install-cost" className="text-sm font-medium text-muted-foreground">
        Estimated AWS cost
      </h2>
      {totalRange ? (
        <p className="text-2xl font-semibold tracking-tight">{totalRange}</p>
      ) : (
        <p className="text-sm text-muted-foreground">AWS cost estimate unavailable.</p>
      )}
      {estimateIncomplete ? (
        <p className="text-xs text-muted-foreground">
          Estimate is incomplete — some resources could not be priced.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        AWS bills your account directly; actual charges depend on usage.
      </p>
      <DocsLink href={DOCS.customerCostEstimate} className="text-xs">
        How to read the estimate
      </DocsLink>
    </section>
  );
}

function CategoryItem({ summary }: { summary: ResourceCategorySummary }) {
  const Icon = CATEGORY_ICON[summary.category];
  const shown = summary.names.slice(0, CATEGORY_NAME_LIMIT).join(' · ');
  const more = summary.names.length - CATEGORY_NAME_LIMIT;
  return (
    <li
      className="flex items-start gap-3 rounded-lg border p-3"
      data-testid={`aws-resource-category-${summary.category}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{summary.label}</span>
        <span className="text-xs text-muted-foreground">
          {shown}
          {more > 0 ? ` · +${more} more` : null}
        </span>
      </div>
    </li>
  );
}
