'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Cloud, KeyRound } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import type { DeploymentPlan } from '@deployz/contracts';

import { ArchitectureDiagram } from '@/components/architecture-diagram';
import { DocsLink } from '@/components/docs-link';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  APPLICATION_ROLE_BOUNDARY,
  CONNECTOR_ROLE,
  distinctActionCount,
  EXECUTION_ROLE,
  EXECUTION_ROLE_REQUIRES_BOUNDARY,
  INSTALL_HELPER_ROLES,
  isGrantedToConnector,
  type PermissionRole,
  type PermissionStatement,
} from '@/lib/bootstrap-permissions';
import { DOCS } from '@/lib/docs-links';
import { awsResourceGroups } from '@/lib/install-plan';
import {
  CONNECTOR_STACK_RESOURCES,
  DATA_NOT_SENT_TO_DEPLOYZ,
  DATA_SENT_TO_DEPLOYZ,
  DELETION_STEPS,
  DENIED_LOG_READ_ACTIONS,
  OWNERSHIP_NOTE,
  RAW_LOGS_GUARANTEE,
  REVOKE_ORDER_NOTE,
  REVOKE_STEPS,
  SECRET_HANDLING_STATEMENT,
  TRAFFIC_RECOMMENDATION,
  TRAFFIC_ROUTING,
} from '@/lib/security-details';

type TabValue = 'overview' | 'permissions' | 'data';

const HIGHLIGHTS = [
  { icon: Cloud, title: 'Your AWS account', text: 'Infrastructure runs in your AWS account.' },
  {
    icon: ArrowUpRight,
    title: 'Outbound connection',
    text: 'The connector starts HTTPS requests to Deployz. No inbound connection is required.',
  },
  { icon: KeyRound, title: 'IAM permissions', text: 'Review the exact access Deployz requires.' },
] as const;

/** Why a statement that is not limited to this installation is still contained. */
const EXCEPTION_NOTES: Record<string, string> = {
  RelayWriteLogs:
    'AWS Lambda uses these actions to write the connector activity log. They add log entries. They cannot read or delete logs.',
  RelayDeregisterRevisions:
    'ECS does not support resource limits on this action. The connector removes only revisions of its own task definitions. A removed revision does not stop a task that uses it.',
  ProvisionApplicationUntaggable:
    'A random password is not an AWS resource, and ECS does not support resource limits on task-definition removal. Only CloudFormation can use this role.',
  ProvisionApplicationCacheCompanions:
    "A cache request also uses the default parameter group and the cache nodes. The cache itself must have this installation's tag.",
};

const listClass = 'flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground';
const orderedListClass = 'flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground';
// The accordion spaces its content with gap, so the default paragraph margin is removed.
const sectionClass = 'flex flex-col gap-4 text-muted-foreground [&_p:not(:last-child)]:mb-0';
const codeClass = 'rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-words text-foreground';

function roleGrants(role: PermissionRole, action: string): boolean {
  return role.statements.some((statement) => statement.actions.includes(action));
}

function scopeText(statement: PermissionStatement): string {
  if (statement.scope === 'installation') {
    if (statement.conditions.some((condition) => condition.includes('ecs:cluster'))) {
      return "Only in this installation's ECS cluster.";
    }
    if (statement.conditions.some((condition) => condition.includes('aws:RequestTag/'))) {
      return "Only when the request carries this installation's tag.";
    }
    if (statement.conditions.some((condition) => condition.includes('aws:ResourceTag/'))) {
      return 'Only on resources tagged for this installation.';
    }
    return "Only on this installation's named resources.";
  }
  if (statement.scope === 'limited') {
    return statement.resources.some((resource) => resource !== '*')
      ? 'Limited by resource name, not to this installation.'
      : 'Limited by a condition, not to this installation.';
  }
  return 'Any resource in the account.';
}

function ActionList({ actions }: { actions: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {actions.map((action) => (
        <li key={action}>
          <code className={codeClass}>{action}</code>
        </li>
      ))}
    </ul>
  );
}

function StatementBlock({ statement }: { statement: PermissionStatement }) {
  const note = statement.sid ? EXCEPTION_NOTES[statement.sid] : undefined;
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium text-foreground">{statement.label}</p>
        <p className="text-xs">{scopeText(statement)}</p>
        {note ? <p className="text-xs">{note}</p> : null}
      </div>
      <ActionList actions={statement.actions} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt>Resource</dt>
        <dd className="flex flex-wrap gap-1.5">
          {statement.resources.map((resource) => (
            <code key={resource} className={codeClass}>
              {resource}
            </code>
          ))}
        </dd>
        {statement.conditions.length > 0 ? (
          <>
            <dt>Condition</dt>
            <dd className="flex flex-col items-start gap-1">
              {statement.conditions.map((condition) => (
                <code key={condition} className={codeClass}>
                  {condition}
                </code>
              ))}
            </dd>
          </>
        ) : null}
        {statement.sid ? (
          <>
            <dt>Sid</dt>
            <dd>
              <code className={codeClass}>{statement.sid}</code>
            </dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

function StatementList({ statements }: { statements: PermissionStatement[] }) {
  return (
    <ul className="flex flex-col divide-y">
      {statements.map((statement, index) => (
        <StatementBlock key={statement.sid ?? index} statement={statement} />
      ))}
    </ul>
  );
}

function RoleHeading({ role, children }: { role: PermissionRole; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold text-foreground">{role.label}</h4>
      <p>
        {distinctActionCount(role)} actions in {role.statements.length} statements.{' '}
        {children}
      </p>
    </div>
  );
}

function Unavailable({ note }: { note: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Infrastructure details are unavailable</p>
      <p className="text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function OverviewTab({
  plan,
  onShowPermissions,
}: {
  plan: DeploymentPlan | null;
  onShowPermissions: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="architecture" className="flex flex-col gap-3">
        <h2 id="architecture" className="text-base font-semibold">
          How it fits together
        </h2>
        {plan ? (
          <ArchitectureDiagram plan={plan} />
        ) : (
          <Unavailable note="The deployment's saved configuration could not be read, so no diagram is shown." />
        )}
      </section>

      <section aria-labelledby="how-it-works" className="flex flex-col gap-3">
        <h2 id="how-it-works" className="text-base font-semibold">
          How it works
        </h2>
        <ol className={orderedListClass}>
          <li>You create the Deployz connector in your AWS account from a standard AWS stack template.</li>
          <li>
            Every minute, the connector calls Deployz over HTTPS and collects commands, such as
            install, update or remove.
          </li>
          <li>
            The connector applies each command with roles in your account and reports the result to
            Deployz.
          </li>
        </ol>
      </section>

      <section aria-labelledby="stays-in-account" className="flex flex-col gap-3">
        <h2 id="stays-in-account" className="text-base font-semibold">
          What stays in your account
        </h2>
        <p className="text-sm text-muted-foreground">
          Your application, databases, stored files and logs stay in your AWS account. Deployz
          receives status and diagnostic information about the deployment. If you delete the
          connector, Deployz has no access to your account.
        </p>
        <Button variant="outline" size="sm" className="w-fit" onClick={onShowPermissions}>
          Review AWS permissions
        </Button>
      </section>
    </div>
  );
}

function PermissionsTab({ plan }: { plan: DeploymentPlan | null }) {
  const groups = awsResourceGroups(plan);
  const roles = [CONNECTOR_ROLE, EXECUTION_ROLE];
  const unscoped = roles.flatMap((role) =>
    role.statements.filter((statement) => statement.scope !== 'installation'),
  );
  const unscopedReads = [
    ...new Set(unscoped.filter((statement) => statement.readOnly).flatMap((s) => s.actions)),
  ].sort();
  const unscopedWrites = unscoped.filter((statement) => !statement.readOnly);
  const notGranted = DENIED_LOG_READ_ACTIONS.filter((action) => !isGrantedToConnector(action));
  const executionRoleManagesRoles =
    roleGrants(EXECUTION_ROLE, 'iam:CreateRole') && roleGrants(EXECUTION_ROLE, 'iam:AttachRolePolicy');

  return (
    <div className="flex flex-col gap-4">
      <h2 className="sr-only">AWS permissions</h2>
      <p className="text-sm text-muted-foreground">
        The connector holds broad permissions, so it can install, update and remove your application
        without manual setup. Each change is limited to this installation: to resources tagged{' '}
        <code className={codeClass}>deployz:installation</code> for this installation, or to
        resources whose names start with this installation&apos;s application stack name. Other
        deployments in the same AWS account and Region are not in this scope. Every action below is
        read from the connector template you deploy.
      </p>

      <Accordion type="multiple" className="rounded-xl border px-4">
        <AccordionItem value="resources">
          <AccordionTrigger>AWS resources created</AccordionTrigger>
          <AccordionContent className={sectionClass}>
            <p>Your application stack and the connector stack create these resources.</p>
            {plan ? (
              <div className="flex flex-col gap-3">
                <h4 className="text-sm font-semibold text-foreground">Application stack</h4>
                {groups.map((group) => (
                  <div key={group.group} className="flex flex-col gap-1">
                    <p className="text-xs font-medium uppercase tracking-wide">{group.label}</p>
                    <ul className={listClass}>
                      {group.resources.map((resource) => (
                        <li key={resource.id}>
                          {resource.name} — {resource.purpose}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <Unavailable note="The deployment's saved configuration could not be read, so no application resource list is shown." />
            )}
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold text-foreground">Connector stack</h4>
              <ul className={listClass}>
                {CONNECTOR_STACK_RESOURCES.map((resource) => (
                  <li key={resource}>{resource}</li>
                ))}
              </ul>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="installation">
          <AccordionTrigger>Initial installation permissions</AccordionTrigger>
          <AccordionContent className={sectionClass}>
            <p>
              Helper functions use these roles only while CloudFormation creates, updates or deletes
              the connector stack. The connector does not use them. Your own AWS user needs
              permission to create the stack, including its IAM roles.
            </p>
            {INSTALL_HELPER_ROLES.map((role) => (
              <div key={role.logicalId} className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-foreground">{role.label}</h4>
                {role.awsManagedPolicies.length > 0 ? (
                  <p className="flex flex-wrap items-center gap-1.5">
                    AWS managed policy:
                    {role.awsManagedPolicies.map((policy) => (
                      <code key={policy} className={codeClass}>
                        {policy}
                      </code>
                    ))}
                  </p>
                ) : null}
                {role.statements.length > 0 ? <StatementList statements={role.statements} /> : null}
              </div>
            ))}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="ongoing">
          <AccordionTrigger>Ongoing connector permissions</AccordionTrigger>
          <AccordionContent className={sectionClass}>
            <p>
              Both roles get all of these permissions when you install the connector, not after its
              first check-in. Deployz chooses the commands and the application template that the
              connector applies.
            </p>
            <div className="flex flex-col gap-1">
              <RoleHeading role={CONNECTOR_ROLE}>
                {CONNECTOR_ROLE.hasPermissionsBoundary
                  ? 'A permissions boundary caps the role at these permissions.'
                  : null}
              </RoleHeading>
              <StatementList statements={CONNECTOR_ROLE.statements} />
            </div>
            <div className="flex flex-col gap-1">
              <RoleHeading role={EXECUTION_ROLE}>
                Only CloudFormation can use this role, for this account. It builds your application
                stack.
                {executionRoleManagesRoles
                  ? EXECUTION_ROLE_REQUIRES_BOUNDARY
                    ? ' It can create IAM roles for your application only under /deployz/, and each role must have the application role boundary.'
                    : ' It can create IAM roles for your application and attach any policy to them.'
                  : null}
                {EXECUTION_ROLE.hasPermissionsBoundary ? null : ' It has no permissions boundary.'}
              </RoleHeading>
              <StatementList statements={EXECUTION_ROLE.statements} />
            </div>
            {executionRoleManagesRoles && EXECUTION_ROLE_REQUIRES_BOUNDARY ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-sm font-semibold text-foreground">Application role boundary</h4>
                <p>
                  These are the most permissions that any IAM role in your application stack can
                  have, even if a policy grants more. A role can be set up for use from outside your
                  account, because AWS cannot limit who a role trusts. Such a role can still do only
                  these actions.
                </p>
                <StatementList statements={APPLICATION_ROLE_BOUNDARY} />
              </div>
            ) : null}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="exceptions">
          <AccordionTrigger>Read-only permissions and exceptions</AccordionTrigger>
          <AccordionContent className={sectionClass}>
            <p>
              These actions are not limited to this installation. Most of them only read. AWS does
              not support tag or name limits on the other actions; the note on each action tells
              how it is controlled.
            </p>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold text-foreground">Read-only actions</h4>
              <ActionList actions={unscopedReads} />
            </div>
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-semibold text-foreground">Other actions</h4>
              <StatementList statements={unscopedWrites} />
            </div>
            {notGranted.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold text-foreground">Not granted</h4>
                <p>The connector writes its own activity log. It cannot read log events:</p>
                <ActionList actions={notGranted} />
              </div>
            ) : null}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function DataTab() {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="application-data" className="flex flex-col gap-2">
        <h2 id="application-data" className="text-base font-semibold">
          Application data
        </h2>
        <p className="text-sm text-muted-foreground">These stay in your AWS account:</p>
        <ul className={listClass}>
          {DATA_NOT_SENT_TO_DEPLOYZ.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{RAW_LOGS_GUARANTEE}</p>
      </section>

      <section aria-labelledby="traffic" className="flex flex-col gap-2">
        <h2 id="traffic" className="text-base font-semibold">
          Application traffic
        </h2>
        <ul className={listClass}>
          {TRAFFIC_ROUTING.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{TRAFFIC_RECOMMENDATION}</p>
      </section>

      <section aria-labelledby="secrets" className="flex flex-col gap-2">
        <h2 id="secrets" className="text-base font-semibold">
          Secrets &amp; credentials
        </h2>
        <p className="text-sm text-muted-foreground">{SECRET_HANDLING_STATEMENT}</p>
        <p className="text-sm text-muted-foreground">
          Values changed after your account connects stay in the update job until the connector
          collects it. Deployz then removes them from the job.
        </p>
        <p className="text-sm text-muted-foreground">
          Deployz does not ask for or store your AWS credentials. The connector signs in to Deployz
          with a token in a Secrets Manager secret in your account.
        </p>
      </section>

      <section aria-labelledby="data-sent" className="flex flex-col gap-2">
        <h2 id="data-sent" className="text-base font-semibold">
          Data shared with Deployz
        </h2>
        <p className="text-sm text-muted-foreground">
          The connector sends this information. Configuration values and secrets that you or your
          software provider enter also pass through Deployz.
        </p>
        <ul className={listClass}>
          {DATA_SENT_TO_DEPLOYZ.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="revoke" className="flex flex-col gap-2">
        <h2 id="revoke" className="text-base font-semibold">
          Revoke access
        </h2>
        <p className="text-sm text-muted-foreground">{OWNERSHIP_NOTE}</p>
        <ol className={orderedListClass}>
          {REVOKE_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-sm font-medium">{REVOKE_ORDER_NOTE}</p>
      </section>

      <section aria-labelledby="deletion" className="flex flex-col gap-2">
        <h2 id="deletion" className="text-base font-semibold">
          Deletion &amp; retained resources
        </h2>
        <ol className={orderedListClass}>
          {DELETION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// §45 Security Details. The application resources and the diagram come from
// the deployment's saved plan (docs/ui-system.md "Plan-driven surfaces"); a
// missing plan shows unavailable states. Every IAM action comes from the
// deployed bootstrap template through @/lib/bootstrap-permissions.
export function SecurityDetailsContent({
  plan,
  backHref,
  backLabel = 'Back to installation',
}: {
  plan: DeploymentPlan | null;
  backHref: string;
  backLabel?: string;
}) {
  const [tab, setTab] = useState<TabValue>('overview');
  const permissionsTabRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link href={backHref}>
          <ArrowLeft data-icon="inline-start" />
          {backLabel}
        </Link>
      </Button>

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Security &amp; AWS access</h1>
        <p className="text-sm text-muted-foreground">
          Review what Deployz installs, what it can access, and how you stay in control.
        </p>
        <DocsLink href={DOCS.customerSecurity}>Read the full security guide</DocsLink>
      </div>

      <ul aria-label="Security highlights" className="grid gap-4 sm:grid-cols-3">
        {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ul>

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <TabsList
          variant="line"
          aria-label="Security sections"
          className="w-full justify-start gap-1 overflow-x-auto border-b sm:gap-4"
        >
          <TabsTrigger value="overview" className="flex-none">
            Overview
          </TabsTrigger>
          <TabsTrigger ref={permissionsTabRef} value="permissions" className="flex-none">
            AWS permissions
          </TabsTrigger>
          <TabsTrigger value="data" className="flex-none">
            Data &amp; control
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <OverviewTab
            plan={plan}
            onShowPermissions={() => {
              setTab('permissions');
              permissionsTabRef.current?.focus();
            }}
          />
        </TabsContent>
        <TabsContent value="permissions" className="pt-4">
          <PermissionsTab plan={plan} />
        </TabsContent>
        <TabsContent value="data" className="pt-4">
          <DataTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
