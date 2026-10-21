/**
 * Trust-story copy for the Security Details page (§45). The IAM actions the
 * page shows are not listed here: they are read from the deployed bootstrap
 * template by `@/lib/bootstrap-permissions`.
 */

/**
 * §16 data boundary — log reads the connector must never hold. The page
 * states only the ones the template does not grant
 * (`isGrantedToConnector` in `@/lib/bootstrap-permissions`).
 */
export const DENIED_LOG_READ_ACTIONS = [
  'logs:GetLogEvents',
  'logs:FilterLogEvents',
] as const;

/**
 * What the connector (bootstrap) stack creates — packages/cdk/src/bootstrap/
 * bootstrap-stack.ts. apps/web/test/security-details.test.ts checks each
 * entry against the resource types in the deployed template.
 */
export const CONNECTOR_STACK_RESOURCES = [
  'Connector function (AWS Lambda) and its EventBridge schedule, which runs it every minute, with the Lambda permission that lets the schedule start it',
  'Connector role, with a permissions boundary and two provisioner policies',
  'CloudFormation execution role for your application stack',
  'Permissions boundary for the IAM roles in your application stack',
  "Secrets Manager secret that holds the connector's Deployz credential",
  "Helper functions and their roles: one creates the installation ID (through the CDK Provider framework), and one sets the 1-week retention of the connector's logs",
  'At run time, the connector writes SSM parameters under /deployz/<installation ID>/ to track unfinished commands',
] as const;

/**
 * §16/§45 "data sent to Deployz" — what the relay reports on its polls:
 * operational metadata plus the AWS diagnostic messages it forwards
 * (packages/relay/src/stack-events.ts, deploy.ts, http-probe.ts, poll.ts),
 * and the configuration values Deployz stores (apps/api/src/config.ts,
 * install-config.ts).
 */
export const DATA_SENT_TO_DEPLOYZ = [
  'Installation ID, AWS account ID and AWS Region',
  'Connector version and the release and container image version that runs',
  'Deployment state, infrastructure status, health state and timestamps',
  'Resource identifiers',
  'AWS error messages: stack events, stopped-task reasons and exit codes',
  'Health-check status code and response time (not the response body)',
  'Configuration values for your application. Deployz stores plain values as they are entered and stores secrets encrypted.',
] as const;

/**
 * §16/§45 "data NOT sent to Deployz" — everything customer-owned stays in the
 * customer's AWS account. Mirrors §16's list verbatim, plus the explicit
 * raw-logs guarantee.
 */
export const DATA_NOT_SENT_TO_DEPLOYZ = [
  'Your application runtime and its in-memory data',
  'Your database data',
  'Your cache contents',
  'Your S3 data',
  'Your application CloudWatch logs',
] as const;

export const RAW_LOGS_GUARANTEE =
  'Deployz does not automatically copy your raw application logs outside your AWS account.';

/**
 * How application traffic reaches the customer's load balancer
 * (docs/networking-and-https.md "Origin TLS and the Cloudflare hop"): the
 * default `d-*` record is proxied through Deployz's Cloudflare zone
 * (apps/api/src/cloudflare-records.ts); a custom domain is the customer's
 * own DNS record to the load balancer.
 */
export const TRAFFIC_ROUTING = [
  "Traffic to your application's default deployz.dev address goes through the Deployz Cloudflare network. HTTPS ends at Cloudflare. Cloudflare then sends the traffic over a new HTTPS connection to the load balancer in your AWS account.",
  'Traffic to a custom domain goes directly to the load balancer in your AWS account. It does not go through Deployz.',
] as const;

export const TRAFFIC_RECOMMENDATION =
  'If you do not want your application traffic to go through Deployz, ask your software provider to add a custom domain, and use only that address. The default address stays available.';

/** §45 "how to revoke Deployz". */
export const REVOKE_STEPS = [
  'Delete the Deployz connector stack in your AWS account. This deletes the connector function, its schedule and its roles.',
  'The connector stops. Deployz has no inbound path into your account, so it cannot reconnect.',
  'Deployz shows the connector as disconnected when it stops receiving check-ins.',
  "Deleting the stack does not delete the connector's CloudWatch log groups or the SSM parameters under /deployz/<installation ID>/ that track unfinished commands. You can delete them yourself.",
] as const;

/**
 * The connector stack holds the CloudFormation execution role the
 * application stack was created with (bootstrap-stack.ts
 * ApplicationExecutionRole; relay install.ts passes it as RoleARN).
 */
export const REVOKE_ORDER_NOTE =
  'Remove the deployment and delete its retained data first. The connector stack also holds the role that CloudFormation uses for your application. After you delete the connector, Deployz cannot change or remove your application, and you must remove those resources yourself.';

/**
 * Ownership clarification — the software provider operates the deployment
 * through Deployz; the customer keeps their AWS account, data, charges, and
 * the revoke procedure described by REVOKE_STEPS. Shared by the Security
 * Details content and the READY-view AWS summary so the wording never
 * diverges.
 */
export const OWNERSHIP_NOTE =
  'Your software provider manages releases and updates through Deployz. You retain ownership of your AWS account, data, AWS charges, and the ability to revoke Deployz access.';

/**
 * ux-guidelines §8's verbatim, verified secrets statement — shown next to
 * every secret field the customer fills in before their AWS account
 * connects (docs/pending-secret-delivery.md). Do not paraphrase: the wording
 * is checked against apps/api/src/public-install.ts's redaction behavior and
 * the control-plane database's 7-day backup retention.
 */
export const SECRET_HANDLING_STATEMENT =
  'Secrets you enter are sent to Deployz over HTTPS and stored encrypted until your AWS account connects. Deployz then delivers them to AWS Secrets Manager in your account and deletes the active copy. If your account does not connect within 24 hours, the secret is deleted and must be entered again. Encrypted backup copies may remain for up to 7 days. Deployz does not display secret values or write them to application logs.';

/** §45 "how deletion works" — mirrors §63's distinctions. */
export const DELETION_STEPS = [
  'Your software provider starts "Remove deployment" from the Deployz dashboard.',
  'The connector removes the application, most of its networking, the HTTPS certificates of the default address and of any custom domain, and the HTTPS (443) listener. It removes only resources tagged for this deployment.',
  'Removal keeps your database (deletion protection on, AWS automated backups continue), its credentials, the storage bucket, the network parts the database uses, and the connector. These retained resources can continue to cost money.',
  '"Delete retained data" is a separate, explicitly confirmed step your software provider runs while the connector is online. It deletes the database without a final snapshot and with its automated backups, any leftover cache, the bucket, application secrets, any leftover certificates, the task-definition revisions, and the remaining network.',
  'The connector stack is yours to delete at any time. Keep it until retained data is deleted, because deletion runs through it.',
  'Deployz keeps its operational metadata for the deployment (IDs, states, timestamps) for your records and billing history.',
] as const;
