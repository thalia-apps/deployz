'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const CONNECTOR_PARAMETERS = ['ControlPlaneUrl', 'EnrollmentCode', 'RelayCredential'] as const;

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

/**
 * The customer updates the connector stack in their own AWS account
 * (docs/customer-access.md). Deployz only gives the steps and the reviewed,
 * versioned template; it never changes the stack itself. The page shows the
 * update as done only when the connector reports the new version.
 */
export function ConnectorUpdateDialog({
  region,
  stackName,
  accountId,
  installedBuildId,
  publishedBuildId,
  updateUrl,
  templateUrl,
  required,
}: {
  region: string;
  stackName: string | null;
  accountId: string | null;
  installedBuildId: string | null;
  publishedBuildId: string | null;
  updateUrl: string | null;
  templateUrl: string | null;
  required: boolean;
}) {
  const cli = templateUrl
    ? [
        'aws cloudformation update-stack \\',
        `  --region ${region} \\`,
        `  --stack-name ${stackName ?? '<connector stack name>'} \\`,
        `  --template-url ${templateUrl} \\`,
        '  --capabilities CAPABILITY_IAM \\',
        `  --parameters ${CONNECTOR_PARAMETERS.map((key) => `ParameterKey=${key},UsePreviousValue=true`).join(' ')}`,
      ].join('\n')
    : null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={required ? 'default' : 'outline'} className="w-fit">
          Update connector
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update the Deployz connector</DialogTitle>
          <DialogDescription>
            {installedBuildId ? `Version ${installedBuildId}` : 'Current version unknown'}
            {publishedBuildId ? ` to ${publishedBuildId}` : ''}. You update the stack in your own AWS
            account{accountId ? ` (${accountId})` : ''}, Region {region}. Your application keeps running.
            The connector can be offline for a few minutes during the update.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          <li>
            Open the connector stack{stackName ? <> <code className="font-mono text-xs">{stackName}</code></> : null} in
            AWS CloudFormation. Select Update, then Replace existing template.
          </li>
          {templateUrl ? <li>Enter the Amazon S3 URL below.</li> : null}
          <li>Keep every parameter at its existing value. Do not change RelayCredential or EnrollmentCode.</li>
          <li>
            Review the changes before you submit. Stop and contact the publisher if a resource shows
            Replacement: True, or if a secret is replaced.
          </li>
          <li>Submit the update. This page shows the result when the connector reports the new version.</li>
        </ol>
        {templateUrl ? <CopyValue label="Template URL" value={templateUrl} /> : null}
        {cli ? (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="link" className="h-auto w-fit px-0 text-sm">
                Use the AWS CLI instead
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <CopyValue label="AWS CLI command" value={cli} />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <DialogFooter>
          {updateUrl ? (
            <Button asChild>
              <a href={updateUrl} target="_blank" rel="noopener noreferrer">
                Open the stack in AWS
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
