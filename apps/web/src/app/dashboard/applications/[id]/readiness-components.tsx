'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { DocsLink } from '@/components/docs-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  type Application,
  type UpdateApplicationInput,
  updateApplication,
} from '@/lib/applications';
import { DOCS } from '@/lib/docs-links';
import {
  detectedFieldValue,
  requirementSummaryKeyFor,
  type ApplicationReadiness,
  type DeploymentRequirementDriftSummary,
  type EditableReadinessField,
} from '@/lib/readiness';
import { requirementDriftLine } from '@/lib/install-plan';

export function RequirementDriftNotice({
  drifts,
}: {
  drifts: DeploymentRequirementDriftSummary[];
}) {
  if (drifts.length === 0) return null;
  return (
    <section aria-labelledby="drift-heading" className="flex flex-col gap-3" data-testid="requirement-drift-notice">
      <Alert>
        <TriangleAlert className="size-4" aria-hidden />
        <AlertTitle>Existing deployments are not changed</AlertTitle>
        <AlertDescription>
          Each deployment keeps the settings it was created with.
        </AlertDescription>
      </Alert>
      <ul className="flex flex-col gap-3">
        {drifts.map((entry) => (
          <li key={entry.deploymentId}>
            <Card data-testid={`requirement-drift-entry-${entry.deploymentId}`}>
              <CardContent className="flex flex-col gap-2 py-4">
                <div className="flex items-center justify-between gap-4">
                  <Link
                    href={`/dashboard/deployments/${entry.deploymentId}`}
                    className="text-sm font-medium hover:underline"
                    data-testid={`requirement-drift-link-${entry.deploymentId}`}
                  >
                    {entry.customerName}
                  </Link>
                  <DeploymentStatusBadge state={entry.state} />
                </div>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {entry.drift.map((item) => (
                    <li key={`${item.kind}:${item.name ?? ''}`}>{requirementDriftLine(item)}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EditDialog({
  field,
  application,
  readiness,
  onClose,
  onSaved,
}: {
  field: EditableReadinessField | null;
  application: Application;
  readiness: ApplicationReadiness;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [pendingAction, setPendingAction] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | number | boolean>(false);
  const [noMigration, setNoMigration] = useState(false);

  // Seed once per open dialog. Status polling replaces application and readiness, which must not reset an edit in progress.
  useEffect(() => {
    if (!field) return;
    setValue(getInitialValue(field, application, readiness));
    const overrides = application.detectedMetadata?.['vendorOverrides'];
    setNoMigration(
      field === 'migrationCommand' &&
        application.migrationCommand === null &&
        Array.isArray(overrides) &&
        overrides.includes('migrationCommand'),
    );
    setError(null);
  }, [field]);

  if (!field) return null;
  const currentField = field;

  const config = FIELD_CONFIG[currentField];
  const isMigration = currentField === 'migrationCommand';
  const missingMigrationChoice = isMigration && !noMigration && String(value).trim() === '';

  async function handleSave(): Promise<void> {
    setPendingAction('save');
    setError(null);
    try {
      const input = isMigration && noMigration ? { migrationCommand: null } : buildUpdateInput(currentField, value);
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the change. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReset(): Promise<void> {
    setPendingAction('reset');
    setError(null);
    try {
      // A null migration command means "No separate migration", so reset uses its own flag.
      const input: UpdateApplicationInput = isMigration ? { resetMigrationCommand: true } : { [currentField]: null };
      await updateApplication(application.id, input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reset the value. Try again.");
    } finally {
      setPendingAction(null);
    }
  }

  const requirementKey = requirementSummaryKeyFor(currentField);
  const requirement = requirementKey ? readiness.requirements?.[requirementKey] : undefined;
  const needsReview = requirementKey !== null && requirement === undefined;
  const vendorOverrides = application.detectedMetadata?.['vendorOverrides'];
  const isOverridden = requirement
    ? requirement.overridden
    : requirementKey === null && Array.isArray(vendorOverrides) && vendorOverrides.includes(currentField);
  const detectedValue = requirementKey === null
    ? detectedFieldValue(currentField, readiness.detected)
    : requirement
      ? requirement.detected
        ? 'Required'
        : 'Not required'
      : 'Needs review';

  return (
    <Dialog open={currentField !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid={`edit-dialog-${currentField}`}>
        <DialogHeader>
          <DialogTitle>{config.label}</DialogTitle>
          <DialogDescription>{config.applies}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-field-${currentField}`}>Use for deployment</Label>
            {config.type === 'boolean' ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id={`edit-field-${currentField}`}
                  checked={Boolean(value)}
                  onChange={(event) => setValue(event.target.checked)}
                  disabled={needsReview}
                />
                {config.booleanLabel}
              </label>
            ) : (
              <Input
                id={`edit-field-${currentField}`}
                type={config.type === 'number' ? 'number' : 'text'}
                disabled={isMigration && noMigration}
                value={String(value ?? '')}
                onChange={(event) =>
                  setValue(
                    config.type === 'number'
                      ? event.target.value === ''
                        ? ''
                        : Number(event.target.value)
                      : event.target.value,
                  )
                }
              />
            )}
          </div>
          {isMigration ? (
            <div className="flex items-center gap-2">
              <Switch id="edit-no-migration" checked={noMigration} onCheckedChange={setNoMigration} />
              <Label htmlFor="edit-no-migration">No separate migration</Label>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {needsReview ? detectedValue : `Detected: ${detectedValue || '—'}`}
          </p>
          {isMigration ? (
            <p className="text-sm text-muted-foreground">
              You cannot add a command to a deployment that was created without a migration step. When you retry a
              failed update, the migration can run again, so the command must be safe to run more than once. Reset to
              detected sends existing deployments back to the command they were created with.
            </p>
          ) : null}
          <DocsLink href={config.docs.href}>{config.docs.label}</DocsLink>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          {isOverridden ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleReset()}
              disabled={pendingAction !== null}
              loading={pendingAction === 'reset'}
              loadingText="Resetting to detected…"
              data-testid={`edit-reset-${field}`}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Reset to detected
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={pendingAction !== null || needsReview || missingMigrationChoice}
            loading={pendingAction === 'save'}
            loadingText="Saving value…"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_CONFIG: Record<
  EditableReadinessField,
  {
    label: string;
    type: 'text' | 'number' | 'boolean';
    booleanLabel?: string;
    /** When a saved change reaches new and existing deployments. */
    applies: string;
    docs: { href: string; label: string };
  }
> = {
  containerPort: {
    label: 'Container port',
    type: 'number',
    applies: 'New deployments use this value. Existing deployments keep the value they were created with.',
    docs: { href: DOCS.requirements, label: 'Application requirements' },
  },
  healthPath: {
    label: 'Health check path',
    type: 'text',
    applies: 'New deployments use this value. Existing deployments keep the value they were created with.',
    docs: { href: DOCS.healthCheckPath, label: 'How the health check works' },
  },
  migrationCommand: {
    label: 'Migration command',
    type: 'text',
    applies: 'New deployments use this choice. An existing deployment uses it on its next release deployment and keeps running as it is until then.',
    docs: { href: DOCS.setMigrationCommand, label: 'How migrations run' },
  },
  databaseRequired: {
    label: 'Database',
    type: 'boolean',
    booleanLabel: 'Database required',
    applies: 'New deployments use this choice. Existing deployments keep the resources they were created with.',
    docs: { href: DOCS.dataServices, label: 'Databases, cache, and file storage' },
  },
  storageRequired: {
    label: 'File storage',
    type: 'boolean',
    booleanLabel: 'File storage required',
    applies: 'New deployments use this choice. Existing deployments keep the resources they were created with.',
    docs: { href: DOCS.dataServices, label: 'Databases, cache, and file storage' },
  },
  redisRequired: {
    label: 'Cache / queue',
    type: 'boolean',
    booleanLabel: 'Redis required',
    applies: 'New deployments use this choice. Existing deployments keep the resources they were created with.',
    docs: { href: DOCS.dataServices, label: 'Databases, cache, and file storage' },
  },
};

function getInitialValue(
  field: EditableReadinessField,
  application: Application,
  readiness: ApplicationReadiness,
): string | number | boolean {
  switch (field) {
    case 'containerPort':
      return application.containerPort ?? '';
    case 'healthPath':
      return application.healthPath ?? '';
    case 'migrationCommand':
      return application.migrationCommand ?? '';
    case 'databaseRequired':
      return readiness.requirements?.database?.effective ?? application.databaseRequired;
    case 'storageRequired':
      return readiness.requirements?.storage?.effective ?? application.storageRequired;
    case 'redisRequired':
      return readiness.requirements?.redis?.effective ?? application.redisRequired;
  }
}

function buildUpdateInput(
  field: EditableReadinessField,
  value: string | number | boolean,
): UpdateApplicationInput {
  switch (field) {
    case 'containerPort':
      return { containerPort: value === '' ? null : Number(value) };
    case 'healthPath':
      return { healthPath: String(value).trim() || null };
    case 'migrationCommand':
      return { migrationCommand: String(value).trim() || null };
    case 'databaseRequired':
      return { databaseRequired: Boolean(value) };
    case 'storageRequired':
      return { storageRequired: Boolean(value) };
    case 'redisRequired':
      return { redisRequired: Boolean(value) };
  }
}
