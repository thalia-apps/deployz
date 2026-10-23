import { FAILURE_CODES } from '@/lib/diagnostic-vocabulary';

// The product documentation lives on the marketing site, not in this app.
// Vendor screens link to the Documentation tab; customer install pages link
// only to the Customer guide (docs/product/ux-guidelines.md).
export const DOCS_URL = 'https://deployz.dev/docs/';

const page = (slug: string) => `${DOCS_URL}${slug}`;

export const DOCS = {
  requirements: page('prepare/requirements'),
  healthCheckPath: page('prepare/requirements#health-check-path'),
  notSupported: page('prepare/not-supported'),
  analysis: page('prepare/analysis'),
  fixFindings: page('prepare/fix-findings'),
  environmentVariables: page('prepare/environment-variables'),
  dataServices: page('prepare/data-services'),
  setMigrationCommand: page('prepare/migrations#set-or-change-the-migration-command'),
  rollbackSafeMigrations: page('prepare/migrations#keep-migrations-safe-for-rollback'),
  createRelease: page('releases/create'),
  buildFailures: page('releases/build-failures'),
  testDeployment: page('share/test-deployment'),
  installLinks: page('share/install-links'),
  invitations: page('share/invitations'),
  defaultAndMinimumSize: page('share/sizes-and-cost#set-the-default-and-minimum-size'),
  regions: page('share/regions'),
  listStatuses: page('operate/deployment-status#statuses-on-the-deployments-list'),
  customerStatuses: page('operate/deployment-status#customer-statuses'),
  deployUpdate: page('operate/deploy-update'),
  restart: page('operate/restart'),
  customerConfiguration: page('operate/configuration'),
  customDomains: page('operate/custom-domains'),
  connectorOffline: page('operate/connector#when-a-connector-goes-offline'),
  newInstallLink: page('operate/connector#you-issue-a-new-install-link'),
  updateConnector: page('operate/connector#update-the-connector'),
  removeDeployment: page('operate/remove'),
  organizationAndTeam: page('account/organization-and-team'),
  github: page('account/github'),
  billing: page('account/billing'),
  troubleshooting: page('troubleshooting/overview'),
  contactSupport: page('troubleshooting/overview#contact-support'),
  analysisProblems: page('troubleshooting/analysis'),
  startupAndHealth: page('troubleshooting/startup-and-health'),
  awsResources: page('reference/aws-resources'),
  customerGuide: page('customers/overview'),
  customerChooseRegion: page('customers/before-you-install#choose-a-region'),
  customerInstallFails: page('customers/install#if-the-deployment-fails'),
  customerLinkDoesNotOpen: page('customers/install#if-the-link-does-not-open'),
  customerSecurity: page('customers/security'),
  customerCostEstimate: page('customers/costs#the-estimate-on-the-install-page'),
  customerWhatRuns: page('customers/costs#what-runs-in-your-account'),
  customerDomainDns: page('customers/custom-domain-dns'),
  customerRemove: page('customers/remove'),
} as const;

// Every documented code has an anchor of its own lowercased name on the
// failure-codes page. UNKNOWN has no entry, so it goes to the overview.
export function failureCodeDocsUrl(code: string): string {
  return code !== 'UNKNOWN' && (FAILURE_CODES as readonly string[]).includes(code)
    ? page(`reference/failure-codes#${code.toLowerCase()}`)
    : DOCS.troubleshooting;
}
