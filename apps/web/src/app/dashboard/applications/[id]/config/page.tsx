'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { deliversConfigValue, type EnvironmentSetting } from '@deployz/contracts';

import { SecretInput } from '@/components/secret-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  fetchConfig,
  mergeConfig,
  saveConfig,
  type ApplicationConfig,
  type ConfigEntry,
  type MaskedConfigEntry,
} from '@/lib/config';
import { fetchEnvironmentSettings } from '@/lib/environment-settings';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

import { useApplicationPage } from '../application-page-context';
import { ResourcesPanel, SizePresetsPanel, resourceAttentionCount } from './deployment-configuration';
import { EnvironmentVariablesSection } from './environment-variables-section';
import { GeneralSettings } from './general-settings';

type PageState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; data: ApplicationConfig };

// §31 application configuration screen — vendor defaults (apply to every
// customer) plus customer-specific overrides (win over the defaults). Secrets
// are write-only end to end: the API masks them (value: null), the screen
// renders a masked write-only field, and saving sends only the NEW value.
// Values are added here too — a group with no values yet is a starting point,
// not a dead end.
// A 404 (e.g. an application id the caller's organization doesn't own) is
// surfaced as the §31 error state, never swallowed into fabricated config.
// Above the forms, the environment plan (AI MVP Phase 4) says which
// variables Deployz configures on its own and which the vendor must provide,
// from the analysis's classified env-var model — the readiness result is
// fetched beside the config and is optional: without it the forms stand alone.
// useSearchParams needs a Suspense boundary at build time.
export default function ApplicationConfigPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConfigScreen />
    </Suspense>
  );
}

function ConfigScreen() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const customerId = searchParams.get('customer');
  const [state, setState] = useState<PageState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const data = await fetchConfig(id, customerId ?? undefined);
        if (cancelled) return;
        setState({ status: 'loaded', data });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "Couldn't load the configuration. Try again.",
          });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, customerId]);

  return (
    <ConfigurationTabs
      applicationId={id}
      resources={<ResourcesPanel />}
      sizes={<SizePresetsPanel />}
      variables={
        <>
          {state.status === 'loading' ? <PageSkeleton /> : null}
          {state.status === 'error' ? (
            <section
              aria-labelledby="config-error"
              className="rounded-xl border border-dashed px-6 py-16 text-center"
            >
              <h2 id="config-error" className="text-lg font-semibold">
                Something went wrong
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
            </section>
          ) : null}
          {state.status === 'loaded' ? (
            <ConfigBody data={state.data} onSaved={(next) => setState({ status: 'loaded', data: next })} />
          ) : null}
        </>
      }
      settings={<GeneralSettings />}
    />
  );
}

type ConfigTab = 'resources' | 'sizes' | 'variables' | 'settings';

const CONFIG_TABS: readonly { value: ConfigTab; label: string }[] = [
  { value: 'resources', label: 'Resources' },
  { value: 'sizes', label: 'Size presets' },
  { value: 'variables', label: 'Variables' },
  { value: 'settings', label: 'Settings' },
];

// Section anchors that links into this page use (Overview, Releases, the
// create page, the rows themselves) and the tab each one lives on.
const HASH_TABS: Readonly<Record<string, ConfigTab>> = {
  'required-changes': 'resources',
  services: 'resources',
  'deployment-size': 'sizes',
  'environment-variables': 'variables',
  settings: 'settings',
};

function tabForHash(hash: string): ConfigTab | null {
  const anchor = hash.replace(/^#/, '');
  if (anchor in HASH_TABS) return HASH_TABS[anchor]!;
  if (anchor.startsWith('config-row-')) return 'resources';
  if (anchor.startsWith('env-row-')) return 'variables';
  return null;
}

function isConfigTab(value: string | null): value is ConfigTab {
  return CONFIG_TABS.some((tab) => tab.value === value);
}

const tabStorageKey = (applicationId: string): string => `deployz:config-tab:${applicationId}`;

function readStoredTab(applicationId: string): ConfigTab | null {
  try {
    const stored = window.sessionStorage.getItem(tabStorageKey(applicationId));
    return isConfigTab(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeTab(applicationId: string, tab: ConfigTab): void {
  try {
    window.sessionStorage.setItem(tabStorageKey(applicationId), tab);
  } catch {
    // Storage can be blocked; the tab then resets on the next visit.
  }
}

// Four secondary tabs. Every panel stays mounted (only hidden), so unsaved
// edits survive a tab switch and a switch loads nothing. A section anchor in
// the URL picks its tab; otherwise the last tab of this application in this
// browser session opens, else Resources.
function ConfigurationTabs({
  applicationId,
  resources,
  sizes,
  variables,
  settings,
}: {
  applicationId: string;
  resources: ReactNode;
  sizes: ReactNode;
  variables: ReactNode;
  settings: ReactNode;
}) {
  const { data } = useApplicationPage();
  const [tab, setTab] = useState<ConfigTab>('resources');

  useEffect(() => {
    const initial = tabForHash(window.location.hash) ?? readStoredTab(applicationId);
    if (initial) setTab(initial);
    function followHash(): void {
      const next = tabForHash(window.location.hash);
      if (next) {
        setTab(next);
        storeTab(applicationId, next);
      }
    }
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [applicationId]);

  function selectTab(next: string): void {
    if (!isConfigTab(next)) return;
    setTab(next);
    storeTab(applicationId, next);
    // Drop a section anchor that pointed at another tab, so following the
    // same link again fires `hashchange` and switches back.
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
  }

  const setup = data?.readiness.environmentSetup ?? null;
  const counts: Partial<Record<ConfigTab, number>> = data
    ? {
        resources: resourceAttentionCount(data.readiness),
        variables: setup ? setup.needsDecision + setup.missingValue : 0,
      }
    : {};
  const panels: Record<ConfigTab, ReactNode> = { resources, sizes, variables, settings };

  return (
    <Tabs value={tab} onValueChange={selectTab} className="gap-6">
      <TabsList aria-label="Configuration sections" className="w-full justify-start overflow-x-auto sm:w-fit">
        {CONFIG_TABS.map((option) => {
          const count = counts[option.value] ?? 0;
          return (
            <TabsTrigger
              key={option.value}
              value={option.value}
              className="flex-none px-2"
              data-testid={`config-tab-${option.value}`}
            >
              {option.label}
              {count > 0 ? (
                <Badge variant="warning" className="h-4 min-w-4 px-1 tabular-nums" data-testid={`config-tab-${option.value}-count`}>
                  {count}
                  <span className="sr-only"> need attention</span>
                </Badge>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {CONFIG_TABS.map((option) => (
        <TabsContent
          key={option.value}
          value={option.value}
          forceMount
          className="flex flex-col gap-6 data-[state=inactive]:hidden"
          data-testid={`config-panel-${option.value}`}
        >
          {panels[option.value]}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ConfigBody({
  data,
  onSaved,
}: {
  data: ApplicationConfig;
  onSaved: (next: ApplicationConfig) => void;
}) {
  const { refresh } = useApplicationPage();
  // A vendor default that the key's decision no longer delivers ("Set by
  // customer", "Managed by Deployz", "Optional") is not shown as this
  // customer's default.
  const [settings, setSettings] = useState<EnvironmentSetting[] | null>(null);
  useEffect(() => {
    if (data.customerId === null) return;
    let cancelled = false;
    fetchEnvironmentSettings(data.applicationId).then(
      (response) => {
        if (!cancelled) setSettings(response.settings);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data.applicationId, data.customerId]);
  const settingsByKey = new Map((settings ?? []).map((setting) => [setting.key, setting]));
  const deliveredVendorDefaults = data.vendorDefaults.filter((entry) =>
    deliversConfigValue(settingsByKey.get(entry.key), 'vendor'),
  );

  return (
    <>
      <EnvironmentVariablesSection
        applicationId={data.applicationId}
        vendorDefaults={data.vendorDefaults}
        onValuesSaved={(saved) =>
          onSaved({
            ...data,
            vendorDefaults: saved.vendorDefaults,
            effective: mergeConfig(saved.vendorDefaults, data.customerOverrides),
          })
        }
        onSaved={() => void refresh()}
      />

      {data.customerId !== null ? (
        <ConfigSection
          title="Customer overrides"
          description={customerScopeDescription(data)}
          helpText="Reaches this customer's running deployment within minutes."
          testId="config-customer-overrides"
          applicationId={data.applicationId}
          customerId={data.customerId}
          entries={data.customerOverrides}
          vendorDefaults={deliveredVendorDefaults}
          editable
          emptyMessage="No overrides for this customer yet."
          onSaved={onSaved}
        />
      ) : null}
    </>
  );
}

// §65: name the customer, never show its id — an id is an internal identifier
// that means nothing to the vendor. An unnamed customer falls back to "this
// customer" rather than leaking the id.
function customerScopeDescription(data: ApplicationConfig): string {
  const customer = data.customerName ?? 'this customer';
  return `For ${customer} only. Overrides the defaults.`;
}

/** A value being added but not yet saved. Secrets carry no stored value yet. */
interface DraftEntry {
  id: number;
  key: string;
  isSecret: boolean;
}

function ConfigSection({
  title,
  description,
  helpText,
  testId,
  applicationId,
  customerId,
  entries,
  vendorDefaults,
  editable,
  emptyMessage,
  onSaved,
}: {
  title: string;
  description: string;
  /** Short note on what saving this section actually does — scoped to what
   *  is true for this section (defaults vs. overrides), never a generic
   *  claim that covers both. Null when there is nothing accurate to add. */
  helpText: string | null;
  testId: string;
  applicationId: string;
  customerId: string | null;
  entries: MaskedConfigEntry[];
  vendorDefaults: MaskedConfigEntry[];
  editable: boolean;
  emptyMessage: ReactNode;
  onSaved: (next: ApplicationConfig) => void;
}) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [nextDraftId, setNextDraftId] = useState(0);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Removals are staged until Save, so one save is one atomic change and a
  // mis-click is undoable before it reaches the server. There was no way to
  // remove a saved value at all before: a mistyped key was permanent, and it
  // kept being injected into every customer deployment.
  const [removed, setRemoved] = useState<readonly string[]>([]);
  // Bumping the form key remounts the fields after a save: non-secret inputs
  // pick up the saved values and write-only secret inputs reset to empty.
  const [version, setVersion] = useState(0);

  function addDraft(isSecret: boolean): void {
    setDrafts((current) => [...current, { id: nextDraftId, key: '', isSecret }]);
    setNextDraftId((current) => current + 1);
    setDraftError(null);
    setSaveState('idle');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const writes: ConfigEntry[] = entries
      .filter((entry) => !removed.includes(entry.key))
      .map((entry) => ({
        key: entry.key,
        value: String(formData.get(entry.key) ?? ''),
        isSecret: entry.isSecret,
      }));

    for (const draft of drafts) {
      const key = draft.key.trim();
      const value = String(formData.get(draftFieldName(draft)) ?? '');
      // The API rejects an empty or duplicate key, and drops a secret with an
      // empty value as "leave unchanged" — a new secret would vanish without
      // a word. Catch all three here with copy that says what to do.
      if (key.length === 0) {
        setDraftError('Give every new value a name.');
        return;
      }
      if (writes.some((write) => write.key === key)) {
        setDraftError(`${key} already exists. Edit it instead.`);
        return;
      }
      if (draft.isSecret && value.length === 0) {
        setDraftError(`Enter a value for ${key}.`);
        return;
      }
      writes.push({ key, value, isSecret: draft.isSecret });
    }

    setDraftError(null);
    setSaveState('saving');
    try {
      const next = await saveConfig(applicationId, customerId, writes, removed);
      onSaved(next);
      setDrafts([]);
      setRemoved([]);
      setVersion((current) => current + 1);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  const empty = entries.length === 0 && drafts.length === 0;

  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form key={version} onSubmit={handleSubmit} className="flex flex-col gap-5">
          {helpText ? <p className="text-xs text-muted-foreground">{helpText}</p> : null}

          {empty ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : null}

          {entries.map((entry) => (
            <ConfigField
              key={entry.key}
              entry={entry}
              vendorDefault={vendorDefaults.find((row) => row.key === entry.key) ?? null}
              showVendorValue={customerId !== null}
              disabled={!editable}
              inputId={`${testId}-${entry.key}`}
              removed={removed.includes(entry.key)}
              onToggleRemove={
                editable
                  ? () =>
                      setRemoved((current) =>
                        current.includes(entry.key)
                          ? current.filter((key) => key !== entry.key)
                          : [...current, entry.key],
                      )
                  : undefined
              }
            />
          ))}

          {drafts.map((draft) => (
            <DraftField
              key={draft.id}
              draft={draft}
              inputId={`${testId}-new-${draft.id}`}
              onKeyChange={(key) =>
                setDrafts((current) =>
                  current.map((row) => (row.id === draft.id ? { ...row, key } : row)),
                )
              }
              onRemove={() => {
                setDrafts((current) => current.filter((row) => row.id !== draft.id));
                setDraftError(null);
              }}
            />
          ))}

          {editable ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`${testId}-add-value`}
                  onClick={() => addDraft(false)}
                >
                  Add value
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`${testId}-add-secret`}
                  onClick={() => addDraft(true)}
                >
                  Add secret
                </Button>
              </div>

              {draftError ? (
                <p role="alert" className="text-sm text-destructive">
                  {draftError}
                </p>
              ) : null}

              {empty ? null : (
                <div className="flex items-center gap-3">
                  <Button
                    type="submit"
                    loading={saveState === 'saving'}
                    loadingText="Saving overrides…"
                  >
                    Save overrides
                  </Button>
                  {saveState === 'saved' ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Saved.
                    </p>
                  ) : null}
                  {saveState === 'error' ? (
                    <p role="alert" className="text-sm text-destructive">
                      Couldn&apos;t save. Try again.
                    </p>
                  ) : null}
                </div>
              )}
            </>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** Form field name for a draft's value — never collides with a real key. */
function draftFieldName(draft: DraftEntry): string {
  return `new-entry-${draft.id}`;
}

function ConfigField({
  entry,
  vendorDefault,
  showVendorValue,
  disabled,
  inputId,
  removed,
  onToggleRemove,
}: {
  entry: MaskedConfigEntry;
  vendorDefault: MaskedConfigEntry | null;
  showVendorValue: boolean;
  disabled: boolean;
  inputId: string;
  removed: boolean;
  onToggleRemove?: (() => void) | undefined;
}) {
  return (
    <div className={`flex flex-col gap-2 ${removed ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="font-mono">
          {entry.key}
        </Label>
        {entry.isSecret ? <Badge variant="secondary">Secret</Badge> : null}
        {removed ? <Badge variant="warning">Removing</Badge> : null}
        {onToggleRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onToggleRemove}
          >
            {removed ? 'Keep' : 'Remove'}
          </Button>
        ) : null}
      </div>
      {removed ? (
        <p className="text-xs text-muted-foreground">
          Removed on save.{entry.isSecret ? ' Also deleted from the customer’s secret store.' : ''}
        </p>
      ) : entry.isSecret ? (
        <>
          <SecretInput
            id={inputId}
            name={entry.key}
            placeholder="••••••••"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Secret set. Enter a new value to replace it.
          </p>
          {entry.needsReentry ? (
            <p className={cn('text-xs', TONE_TEXT.attention)}>Re-enter this secret.</p>
          ) : null}
        </>
      ) : (
        <>
          <Input
            id={inputId}
            name={entry.key}
            defaultValue={entry.value ?? ''}
            disabled={disabled}
          />
          {showVendorValue &&
          vendorDefault &&
          !vendorDefault.isSecret &&
          vendorDefault.value !== entry.value ? (
            <p className="text-xs text-muted-foreground">Default: {vendorDefault.value}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

// A value being added. The name is controlled state (the submit handler needs
// it to build the write and to catch duplicates); the value rides the form,
// through a write-only secret field when the draft is a secret.
function DraftField({
  draft,
  inputId,
  onKeyChange,
  onRemove,
}: {
  draft: DraftEntry;
  inputId: string;
  onKeyChange: (key: string) => void;
  onRemove: () => void;
}) {
  const valueId = `${inputId}-value`;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4" data-testid="config-draft">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">New {draft.isSecret ? 'secret' : 'value'}</p>
        {draft.isSecret ? <Badge variant="secondary">Secret</Badge> : null}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={inputId}>Name</Label>
          <Input
            id={inputId}
            className="font-mono"
            autoComplete="off"
            placeholder="LOG_LEVEL"
            value={draft.key}
            onChange={(event) => onKeyChange(event.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor={valueId}>Value</Label>
          {draft.isSecret ? (
            <SecretInput id={valueId} name={draftFieldName(draft)} />
          ) : (
            <Input id={valueId} name={draftFieldName(draft)} autoComplete="off" />
          )}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// The "Add value"/"Add secret" controls don't depend on what fetchConfig
// returns — they open an empty draft row regardless. Rendering them here,
// disabled, means a click that lands before the fetch resolves hits a real
// control instead of a skeleton block that silently swallows it.
function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="config-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="flex flex-col gap-3 rounded-xl border p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-64" />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled>
            Add value
          </Button>
          <Button type="button" variant="outline" size="sm" disabled>
            Add secret
          </Button>
        </div>
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
