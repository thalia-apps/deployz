'use client';

import { ChevronDown, Info, TriangleAlert } from 'lucide-react';
import { Fragment, forwardRef, useEffect, useRef, useState } from 'react';

import { FixInstructionsDialog } from '@/components/fix-instructions-dialog';
import { TechnicalDetails } from '@/components/technical-details';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import type { Application, AnalysisStatus } from '@/lib/applications';
import { deriveAnalysisDetails, deriveRequiredChanges, type AnalysisDetail } from '@/lib/application-configuration';
import {
  deriveServiceInventory,
  formatRowCost,
  type InventoryAction,
  type InventoryGroup,
  type InventoryRow,
  type RowAfterRemoval,
  type RowCost,
} from '@/lib/configuration-inventory';
import type {
  ApplicationArchitecture,
  ApplicationReadiness,
  DeploymentRequirementDriftSummary,
  EditableReadinessField,
} from '@/lib/readiness';

import { useApplicationPage } from '../application-page-context';
import { EditDialog, RequirementDriftNotice } from '../readiness-components';
import { DeploymentSize } from './deployment-size';

const COLUMN_COUNT = 3;

const NODE_STATE_COPY: Record<'detected' | 'confirmed', string> = {
  detected: 'Detected automatically',
  confirmed: 'Confirmed',
};

/** The one edit/fix dialog pair every row and the attention summary route into. */
export function ConfigurationDialogs({
  applicationId,
  application,
  readiness,
  editingField,
  fixOpen,
  onCloseFix,
  onCloseEdit,
  onReanalyse,
  onSaved,
}: {
  applicationId: string;
  application: Application;
  readiness: ApplicationReadiness;
  editingField: EditableReadinessField | null;
  fixOpen: boolean;
  onCloseFix: () => void;
  onCloseEdit: () => void;
  onReanalyse: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <>
      <FixInstructionsDialog
        open={fixOpen}
        applicationId={applicationId}
        onClose={onCloseFix}
        onReanalyse={onReanalyse}
      />
      <EditDialog
        field={editingField}
        application={application}
        readiness={readiness}
        onClose={onCloseEdit}
        onSaved={onSaved}
      />
    </>
  );
}

/**
 * How many items on the Resources tab need the vendor: the required changes
 * and the unresolved architecture questions. Recommended findings and
 * external services stay on their rows without a count.
 */
export function resourceAttentionCount(readiness: ApplicationReadiness): number {
  return deriveRequiredChanges(readiness).length + (readiness.architecture?.unresolved.length ?? 0);
}

// The Configuration tab's "Resources" panel: a short attention line, then
// one flat row per service, setting and integration. Each issue shows on the
// row it belongs to, beside the action that opens that row's editor.
export function ResourcesPanel() {
  const { data, loading, presentation, refresh, reanalyse } = useApplicationPage();
  const [editingField, setEditingField] = useState<EditableReadinessField | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // The dialogs open from state, not from a Radix trigger, so Radix has no
  // element to return focus to on close — keep the opener and restore it.
  const openerRef = useRef<HTMLElement | null>(null);

  const inventory = data ? deriveServiceInventory(data) : null;
  const attentionCount = data ? resourceAttentionCount(data.readiness) : 0;
  const setup = data?.readiness.environmentSetup ?? null;
  const variableCount = setup ? setup.needsDecision + setup.missingValue : 0;
  const hasAttention = attentionCount > 0 || variableCount > 0;

  // A link into this page (from the Overview tab, or a bookmarked URL) can
  // carry `#required-changes` — on load, and whenever the hash changes again
  // without a full navigation, scroll to and focus the summary. With nothing
  // to fix, focus the resources heading instead of a summary that is gone.
  // The next frame lets the tab switch to Resources first.
  useEffect(() => {
    if (!data) return;
    function focusRequiredChanges(): void {
      if (window.location.hash !== '#required-changes') return;
      requestAnimationFrame(() => {
        const target = hasAttention ? panelRef.current : headingRef.current;
        // jsdom (unit tests) has no `scrollIntoView` implementation.
        target?.scrollIntoView?.({ block: 'start' });
        target?.focus();
      });
    }
    focusRequiredChanges();
    window.addEventListener('hashchange', focusRequiredChanges);
    return () => window.removeEventListener('hashchange', focusRequiredChanges);
  }, [data, hasAttention]);

  if (loading) return <DeploymentConfigurationSkeleton />;
  if (!data || !inventory) return null;

  const { application, readiness } = data;
  const analyzing = application.analysisStatus === 'ANALYZING';

  function rememberOpener(): void {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  function restoreFocus(): void {
    const opener = openerRef.current;
    requestAnimationFrame(() => opener?.focus());
  }
  function runAction(action: InventoryAction): void {
    rememberOpener();
    if (action.kind === 'edit') setEditingField(action.field);
    else setFixOpen(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <AttentionSummary ref={panelRef} count={attentionCount} variableCount={variableCount} />

      <ServicesSection
        ref={headingRef}
        groups={inventory.groups}
        analyzing={analyzing}
        analysisStatus={application.analysisStatus}
        readinessSummary={presentation.readinessSummary}
        analyzedCommitSha={readiness.analyzedCommitSha}
        details={deriveAnalysisDetails(readiness)}
        architecture={readiness.architecture ?? null}
        drifts={readiness.deploymentRequirementDrift}
        onAction={runAction}
      />

      <ConfigurationDialogs
        applicationId={application.id}
        application={application}
        readiness={readiness}
        editingField={editingField}
        fixOpen={fixOpen}
        onCloseFix={() => {
          setFixOpen(false);
          restoreFocus();
        }}
        onCloseEdit={() => {
          setEditingField(null);
          restoreFocus();
        }}
        onReanalyse={() => {
          void reanalyse();
          setFixOpen(false);
        }}
        onSaved={refresh}
      />
    </div>
  );
}

// The "Size presets" panel: the three fixed presets side by side, then the
// default and minimum sizes. Shown once an analysis has completed, because
// each preset's resources and cost come from its plan.
export function SizePresetsPanel() {
  const { data, loading, refresh } = useApplicationPage();
  if (loading) return <DeploymentConfigurationSkeleton />;
  if (!data) return null;
  if (data.application.analysisStatus !== 'COMPLETE') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="deployment-size-empty">
        {data.application.analysisStatus === 'ANALYZING'
          ? 'Size presets show when the analysis finishes.'
          : 'Size presets show after a successful analysis.'}
      </p>
    );
  }
  const inventory = deriveServiceInventory(data);
  return (
    <DeploymentSize
      application={data.application}
      plan={data.plan}
      externalServices={inventory.externalServices}
      unestimatedWorkload={inventory.unestimatedWorkload}
      onSaved={refresh}
    />
  );
}

const AttentionSummary = forwardRef<HTMLDivElement, { count: number; variableCount: number }>(
  function AttentionSummary({ count, variableCount }, ref) {
    if (count === 0 && variableCount === 0) return null;
    return (
      <div
        ref={ref}
        id="required-changes"
        tabIndex={-1}
        className="flex scroll-mt-20 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-destructive/40 px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        data-testid="attention-summary"
      >
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        {count > 0 ? (
          <p data-testid="attention-summary-resources">
            {count} {count === 1 ? 'item needs' : 'items need'} attention. Fix {count === 1 ? 'it' : 'them'} on the
            marked {count === 1 ? 'row' : 'rows'}.
          </p>
        ) : null}
        {variableCount > 0 ? (
          <Button asChild variant="link" size="sm" className="h-auto p-0" data-testid="attention-summary-variables">
            <a href="#environment-variables">
              {variableCount} {variableCount === 1 ? 'variable needs' : 'variables need'} input
            </a>
          </Button>
        ) : null}
      </div>
    );
  },
);

const ServicesSection = forwardRef<
  HTMLHeadingElement,
  {
    groups: InventoryGroup[];
    analyzing: boolean;
    analysisStatus: AnalysisStatus;
    readinessSummary: string | null;
    analyzedCommitSha: string | null;
    details: AnalysisDetail[];
    architecture: ApplicationArchitecture | null;
    drifts: DeploymentRequirementDriftSummary[];
    onAction: (action: InventoryAction) => void;
  }
>(function ServicesSection(
  { groups, analyzing, analysisStatus, readinessSummary, analyzedCommitSha, details, architecture, drifts, onAction },
  ref,
) {
  const hasKept = groups.some((group) =>
    group.rows.some((row) => row.afterRemoval === 'Kept' || row.afterRemoval === 'Mixed'),
  );
  const detectedGroups = architecture?.groups ?? [];

  return (
    <section id="services" aria-labelledby="services-heading" className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="services-heading" ref={ref} tabIndex={-1} className="text-base font-semibold outline-none">
          Resources
        </h2>
        <p className="text-sm text-muted-foreground">
          {[readinessSummary, analyzedCommitSha ? `Analysed commit ${analyzedCommitSha.slice(0, 7)}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      <div className="rounded-lg border">
        <Table data-testid="services-table" className="max-md:block">
          <TableHeader className="max-md:hidden">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-56">Resource</TableHead>
              <TableHead>Configuration</TableHead>
              <TableHead className="w-40">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={analyzing || undefined} className="max-md:block">
            {groups.map((group) => (
              <Fragment key={group.id}>
                <TableRow className="hover:bg-transparent max-md:block" data-testid={`services-group-${group.id}`}>
                  <TableHead
                    colSpan={COLUMN_COUNT}
                    scope="colgroup"
                    className="h-8 text-xs font-medium tracking-wide text-muted-foreground uppercase max-md:block max-md:pt-2"
                  >
                    {group.label}
                  </TableHead>
                </TableRow>
                {group.rows.map((row) => (
                  <ServiceRow key={row.id} row={row} onAction={onAction} />
                ))}
              </Fragment>
            ))}
            {groups.length === 0 ? <ServicesTablePlaceholder analysisStatus={analysisStatus} /> : null}
          </TableBody>
        </Table>
      </div>

      {hasKept ? (
        <p className="text-xs text-muted-foreground">
          Kept resources stay in the customer&apos;s AWS account after removal and keep costing money until their data
          is deleted.
        </p>
      ) : null}

      {details.length > 0 || detectedGroups.length > 0 ? (
        <TechnicalDetails>
          <div className="flex flex-col gap-4">
            {detectedGroups.length > 0 ? (
              <div data-testid="detected-components">
                <h3 className="text-sm font-medium">Detected components</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  {detectedGroups.flatMap((group) =>
                    group.nodes.map((node) => (
                      <li key={`${group.group}-${node.label}`}>
                        {node.label} · {NODE_STATE_COPY[node.state]}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : null}
            {details.map((detail) => (
              <div key={detail.id}>
                <h3 className="text-sm font-medium">{detail.label}</h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                  {detail.lines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </TechnicalDetails>
      ) : null}
      <RequirementDriftNotice drifts={drifts} />
    </section>
  );
});

function costText(cost: RowCost): string | null {
  if (cost === null) return null;
  if (cost === 'billed-separately') return 'Billed separately';
  if (cost === 'not-estimated') return 'Cost not estimated';
  return `Est. AWS/month: ${formatRowCost(cost)}`;
}

function afterRemovalText(afterRemoval: RowAfterRemoval): string | null {
  if (afterRemoval === 'Kept') return 'Kept after removal';
  if (afterRemoval === 'Mixed') return 'Partly kept after removal';
  if (afterRemoval === 'Not determined') return 'After removal not determined';
  return null;
}

function ServiceRow({ row, onAction }: { row: InventoryRow; onAction: (action: InventoryAction) => void }) {
  const action = row.action;
  const mixed = row.afterRemoval === 'Mixed';
  const meta = [costText(row.cost), afterRemovalText(row.afterRemoval)].filter(Boolean).join(' · ');

  return (
    <TableRow
      id={`config-row-${row.id}`}
      className="scroll-mt-20 hover:bg-transparent max-md:flex max-md:flex-col max-md:gap-1.5 max-md:py-2"
      data-testid={row.testId}
    >
      <TableCell
        className={
          row.indent
            ? 'pl-8 align-top text-muted-foreground max-md:py-0 max-md:pl-6'
            : 'align-top font-medium max-md:py-0'
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{row.label}</span>
          {row.help ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Details for ${row.label}`} className="text-muted-foreground">
                  <Info aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72">
                <p className="text-sm text-muted-foreground">{row.help}</p>
                {row.fixInstructions ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-2 h-auto p-0"
                    onClick={() => onAction(row.fixInstructions!)}
                    data-testid={row.fixInstructions.testId}
                  >
                    {row.fixInstructions.label}
                  </Button>
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
          {row.issues.map((issue, index) => (
            <Badge key={index} variant={issue.variant}>
              {issue.label}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal max-md:py-0">
        <div className="flex min-w-0 flex-col gap-1">
          {row.configuration ? (
            row.command ? (
              <code className="font-mono text-xs break-all whitespace-pre-wrap">{row.configuration}</code>
            ) : (
              <span>{row.configuration}</span>
            )
          ) : null}
          {row.detail ? <span className="text-xs text-muted-foreground">{row.detail}</span> : null}
          {row.issues.map((issue, index) =>
            issue.text ? (
              <span key={index} className="text-xs text-muted-foreground">
                {issue.text}
              </span>
            ) : null,
          )}
          {meta ? (
            <span className="text-xs text-muted-foreground tabular-nums" data-testid={`${row.testId}-meta`}>
              {meta}
            </span>
          ) : null}
          {row.resources.length > 0 ? (
            // AWS resource names stay one click away, so the page's top-level
            // copy stays free of AWS terms (ux-guidelines §65).
            <Collapsible data-testid={`${row.testId}-resources`}>
              <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                Planned AWS resources ({row.resources.length})
                <ChevronDown aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {row.resources.map((resource) => (
                    <li key={resource.id} data-testid={`inventory-resource-${resource.id}`}>
                      <span className="text-foreground">{resource.name}</span> · {resource.purpose}
                      {mixed ? ` · ${resource.afterRemoval}` : ''}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="align-top max-md:py-0 max-md:empty:hidden md:text-right">
        {action?.kind === 'link' ? (
          <Button asChild variant="outline" size="sm" data-testid={action.testId}>
            <a href={action.href}>{action.label}</a>
          </Button>
        ) : action ? (
          <Button variant="outline" size="sm" onClick={() => onAction(action)} data-testid={action.testId}>
            {action.label}
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

// The rows only exist once an analysis has completed. While one runs, the
// table keeps its geometry with skeleton rows; before the first analysis it
// says what the vendor has to do to fill it.
function ServicesTablePlaceholder({ analysisStatus }: { analysisStatus: AnalysisStatus }) {
  if (analysisStatus === 'ANALYZING') {
    return (
      <>
        <TableRow>
          <TableCell colSpan={COLUMN_COUNT} className="sr-only" role="status">
            Checking deployment configuration…
          </TableCell>
        </TableRow>
        {[0, 1, 2].map((index) => (
          <TableRow key={index} aria-hidden data-testid="readiness-row-skeleton">
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-48" />
            </TableCell>
            <TableCell />
          </TableRow>
        ))}
      </>
    );
  }

  const message =
    analysisStatus === 'FAILED'
      ? 'Shown after a successful analysis.'
      : 'Analyse the application to see its configuration.';
  return (
    <TableRow>
      <TableCell colSpan={COLUMN_COUNT} className="text-muted-foreground" data-testid="readiness-empty">
        {message}
      </TableCell>
    </TableRow>
  );
}

export function DeploymentConfigurationSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" data-testid="deployment-configuration-loading">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
