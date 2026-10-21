import { describe, expect, it } from 'vitest';

import {
  COMPATIBILITY_VERDICTS,
  CONFIGURATION_FAILURE_CODES,
  COPY_RULES_65,
  DEPLOYMENT_STATE_BADGE,
  DEPLOYMENT_STATE_LABELS,
  DEPLOYMENT_STATES,
  EXPLANATION_FALLBACK,
  FAILURE_CODE_COPY,
  FAILURE_CODES,
  FAILURE_RECOVERABILITY,
  FAILURE_REMEDIATION,
  FAILURE_SEVERITY_BADGE,
  FAILURE_SEVERITY_DOT,
  JARGON_PATTERN,
  ONBOARDING_STEPS,
  READINESS_STATE_PRESENTATION,
  READINESS_STATES,
  RECOVERABILITY_COPY,
  RELAY_CHECK_COPY,
  RELAY_CHECK_FALLBACK_COPY,
  RELAY_CHECK_NAMES,
  SECRET_MASK,
  customerStackStatusLabel,
  releaseBuildFailureSummary,
  deploymentStateLabel,
  eventFamily,
  eventResultLabel,
  eventTypeLabel,
  failureCodeCopy,
  knownFailureCode,
  failureRecoverability,
  readinessChangesHeading,
  readinessChecksLabel,
  readinessStateFromVerdict,
  readinessStateHeading,
  relayCheckCopy,
} from '../src/index';

// Locks the §46/§61/§19 vocabulary + §65 copy principles in the single
// source of truth (packages/copy-map). Every label at the top level must be
// jargon-free; raw AWS/CFN/ECS/IAM terms must not appear.

// ── §46 deployment states ───────────────────────────────────────────────────

describe('§46 deployment states', () => {
  it('defines exactly the product-vocabulary states', () => {
    expect(DEPLOYMENT_STATES).toEqual([
      'NOT_INSTALLED',
      'WAITING_FOR_RELAY',
      'INSTALLING',
      'HEALTHY',
      'UPDATING',
      'UPDATE_AVAILABLE',
      'FAILED',
      'DISCONNECTED',
      'DELETING',
      'DELETED',
    ]);
  });

  it('maps every state to a non-empty, jargon-free label', () => {
    for (const state of DEPLOYMENT_STATES) {
      const label = DEPLOYMENT_STATE_LABELS[state];
      expect(label, `label for ${state}`).toBeTruthy();
      expect(label, `label for ${state}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('uses the plan §46 product wording for the key states', () => {
    expect(DEPLOYMENT_STATE_LABELS.HEALTHY).toBe('Healthy');
    expect(DEPLOYMENT_STATE_LABELS.INSTALLING).toBe('Installing');
    expect(DEPLOYMENT_STATE_LABELS.FAILED).toBe('Failed');
    expect(DEPLOYMENT_STATE_LABELS.UPDATE_AVAILABLE).toBe('Update available');
  });

  it('marks FAILED and DISCONNECTED as destructive', () => {
    expect(DEPLOYMENT_STATE_BADGE.FAILED).toBe('destructive');
    expect(DEPLOYMENT_STATE_BADGE.DISCONNECTED).toBe('destructive');
  });

  it('maps every state to a valid badge variant', () => {
    const validVariants = ['default', 'secondary', 'destructive', 'outline', 'success', 'warning', 'info'];
    for (const state of DEPLOYMENT_STATES) {
      expect(validVariants, `badge for ${state}`).toContain(DEPLOYMENT_STATE_BADGE[state]);
    }
  });

  it('deploymentStateLabel falls back to raw string for unknown states', () => {
    expect(deploymentStateLabel('SOME_UNKNOWN')).toBe('SOME_UNKNOWN');
  });
});

// ── §40 event families ──────────────────────────────────────────────────────

describe('§40 event families', () => {
  it('classifies the six §40 families', () => {
    expect(eventFamily('deploy.state.updating')).toBe('deploy');
    expect(eventFamily('rollback.restore')).toBe('rollback');
    expect(eventFamily('config.write')).toBe('config');
    expect(eventFamily('health.report')).toBe('health');
    expect(eventFamily('install.state.healthy')).toBe('install');
    expect(eventFamily('destroy.state.started')).toBe('destroy');
    expect(eventFamily('billing.usage')).toBeNull();
  });

  it('maps known workflow event types to human labels', () => {
    expect(eventTypeLabel('deploy.state.updating')).toBe('Update started');
    expect(eventTypeLabel('rollback.restore')).toBe('Previous version restored');
    expect(eventTypeLabel('install.state.healthy')).toBe('Installed and healthy');
    expect(eventTypeLabel('deploy.state.update-available')).toBe('Update available');
  });

  it('falls back to a family label for an unknown type (never raw)', () => {
    expect(eventTypeLabel('health.report')).toBe('Health');
    expect(eventTypeLabel('destroy.state.started')).toBe('Teardown');
  });

  it('classifies the redis family and maps its known event types', () => {
    expect(eventFamily('redis.provision.started')).toBe('redis');
    expect(eventTypeLabel('redis.provision.started')).toBe('Setting up cache');
    expect(eventTypeLabel('redis.provision.succeeded')).toBe('Cache ready');
    expect(eventTypeLabel('redis.provision.failed')).toBe('Cache setup failed');
  });

  it('falls back to the redis family label for an unknown redis event (never raw)', () => {
    expect(eventTypeLabel('redis.something.unmapped')).toBe('Cache');
  });

  it('produces no raw AWS terms for any known or fallback label', () => {
    const allTypes = [
      'install.preflight.region',
      'install.preflight.scp',
      'install.relay.contact',
      'install.state.installing',
      'install.relay.health',
      'install.state.healthy',
      'deploy.preflight',
      'deploy.state.updating',
      'deploy.migration',
      'deploy.ecs-update',
      'deploy.infra-upgrade',
      'deploy.health',
      'deploy.state.healthy',
      'deploy.state.update-available',
      'rollback.state.updating',
      'rollback.disclosure',
      'rollback.restore',
      'rollback.health',
      'rollback.state.healthy',
      'config.validate',
      'config.write',
      'config.health',
      'config.state.healthy',
      'destroy.state.started',
      'health.report',
      'redis.provision.started',
      'redis.provision.succeeded',
      'redis.provision.failed',
    ];
    for (const type of allTypes) {
      expect(eventTypeLabel(type), `label for ${type}`).not.toMatch(JARGON_PATTERN);
    }
  });
});

// ── §62 event result labels ─────────────────────────────────────────────────

describe('§62 event result labels', () => {
  it('maps results to jargon-free labels', () => {
    expect(eventResultLabel('ok')).toBe('Succeeded');
    expect(eventResultLabel('passed')).toBe('Succeeded');
    expect(eventResultLabel('skipped')).toBe('Skipped');
    expect(eventResultLabel('failed:MIGRATION_FAILED')).toBe('Failed');
    expect(eventResultLabel(null)).toBeNull();
  });

  it('produces no raw AWS terms in result labels', () => {
    expect(eventResultLabel('ok')).not.toMatch(JARGON_PATTERN);
    expect(eventResultLabel('failed:MIGRATION_FAILED')).not.toMatch(JARGON_PATTERN);
  });
});

// ── §61 failure codes ───────────────────────────────────────────────────────

describe('MIGRATION_FAILED remediation', () => {
  it('does not claim a previous version is running (a first install has none)', () => {
    expect(FAILURE_REMEDIATION.MIGRATION_FAILED.fix).not.toMatch(/previous version/i);
  });
});

describe('§61 failure codes', () => {
  it('defines exactly the twenty-three §61 taxonomy codes', () => {
    expect(FAILURE_CODES).toEqual([
      'AWS_SCP_BLOCKED',
      'PORT_MISMATCH',
      'REGION_NOT_SUPPORTED',
      'QUOTA_EXCEEDED',
      'IMAGE_HEALTH_CHECK_FAILED',
      'MIGRATION_FAILED',
      'RELAY_DISCONNECTED',
      'ECS_DEPLOYMENT_FAILED',
      'AWS_PERMISSION_DENIED',
      'STACK_CREATE_FAILED',
      'STACK_DELETE_FAILED',
      'RDS_AZ_CAPACITY',
      'DATABASE_CREATE_FAILED',
      'DATABASE_CONNECTION_FAILED',
      'IMAGE_PULL_FAILED',
      'CONTAINER_START_FAILED',
      'MISSING_SECRET',
      'TEMPLATE_UNAVAILABLE',
      'UNSUPPORTED_ARCHITECTURE',
      'UNKNOWN',
      'REDIS_PROVISIONING_FAILED',
      'REDIS_CONNECTION_FAILED',
      'DOMAIN_OPERATION_TIMEOUT',
      'RELAY_STATE_WRITE_FAILED',
    ]);
  });

  it('maps every code to non-empty, jargon-free label and description', () => {
    for (const code of FAILURE_CODES) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label, `label for ${code}`).toBeTruthy();
      expect(copy.description, `description for ${code}`).toBeTruthy();
      expect(copy.label, `label for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(copy.description, `description for ${code}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('keeps raw service names out of even the sensitive codes', () => {
    expect(FAILURE_CODE_COPY.AWS_SCP_BLOCKED.label).toBe('Cloud policy blocks this');
    expect(FAILURE_CODE_COPY.PORT_MISMATCH.label).toBe('Port conflict');
    expect(FAILURE_CODE_COPY.ECS_DEPLOYMENT_FAILED.label).toBe('Deployment failed');
    expect(FAILURE_CODE_COPY.RELAY_DISCONNECTED.label).toBe('Helper disconnected');
  });

  it('maps the two Redis MVP codes to plain-English, "Redis"-flavored copy', () => {
    expect(FAILURE_CODE_COPY.REDIS_PROVISIONING_FAILED.label).toBe('Cache setup failed');
    expect(FAILURE_CODE_COPY.REDIS_CONNECTION_FAILED.label).toBe("App can't reach its cache");

    // §65 + Redis MVP global constraint: "ElastiCache"/"Valkey" (the AWS
    // implementation names) never appear at the top level, even though
    // "Redis" itself is acceptable product-language.
    for (const code of ['REDIS_PROVISIONING_FAILED', 'REDIS_CONNECTION_FAILED'] as const) {
      const copy = FAILURE_CODE_COPY[code];
      expect(copy.label).not.toMatch(/ElastiCache|Valkey/i);
      expect(copy.description).not.toMatch(/ElastiCache|Valkey/i);
      const remediation = FAILURE_REMEDIATION[code];
      expect(remediation.what).not.toMatch(/ElastiCache|Valkey/i);
      expect(remediation.why).not.toMatch(/ElastiCache|Valkey/i);
      expect(remediation.fix).not.toMatch(/ElastiCache|Valkey/i);
    }
  });

  it('customer descriptions for the app-owned failure codes name the vendor as the actor', () => {
    expect(FAILURE_CODE_COPY.CONTAINER_START_FAILED.description).toBe(
      'The application stopped shortly after starting. The vendor needs to fix the application before deployment can continue.',
    );
    expect(FAILURE_CODE_COPY.IMAGE_HEALTH_CHECK_FAILED.description).toBe(
      "The app started, but its health check isn't passing. The vendor needs to fix the application before deployment can continue.",
    );
    expect(FAILURE_CODE_COPY.DATABASE_CONNECTION_FAILED.description).toBe(
      "The app can't reach the database. The vendor needs to fix the application before deployment can continue.",
    );
    expect(FAILURE_CODE_COPY.MIGRATION_FAILED.description).toBe(
      "A database migration step didn't finish successfully. The vendor needs to fix the application before deployment can continue.",
    );
    // Configuration-class codes keep their accurate first clause; the
    // who-acts sentence is adapted so it never contradicts the fix guidance.
    expect(FAILURE_CODE_COPY.MISSING_SECRET.description).toBe(
      'A required secret is not configured. The vendor needs to set it before deployment can continue.',
    );
    expect(FAILURE_CODE_COPY.PORT_MISMATCH.description).toBe(
      'Your app listens on one port, but the service expects another. The vendor needs to correct it before deployment can continue.',
    );
  });

  it('gives every §61 code non-empty, jargon-free what/why/fix remediation', () => {
    for (const code of FAILURE_CODES) {
      const remediation = FAILURE_REMEDIATION[code];
      expect(remediation.what, `what for ${code}`).toBeTruthy();
      expect(remediation.why, `why for ${code}`).toBeTruthy();
      expect(remediation.fix, `fix for ${code}`).toBeTruthy();
      expect(remediation.what, `what for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(remediation.why, `why for ${code}`).not.toMatch(JARGON_PATTERN);
      expect(remediation.fix, `fix for ${code}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('CONFIGURATION_FAILURE_CODES are exactly the codes whose fix names the Configuration screen', () => {
    for (const code of FAILURE_CODES) {
      expect(
        CONFIGURATION_FAILURE_CODES.has(code),
        `${code} Configuration action matches its remediation`,
      ).toBe(FAILURE_REMEDIATION[code].fix.includes('Configuration screen'));
    }
  });

  it('CONTAINER_START_FAILED remediation names the start command, the port and the required values', () => {
    const { fix } = FAILURE_REMEDIATION.CONTAINER_START_FAILED;
    expect(fix).toMatch(/start command/);
    expect(fix).toMatch(/port/);
    expect(fix).toMatch(/required values/);
  });

  it('REDIS_CONNECTION_FAILED remediation mentions redeploying', () => {
    expect(FAILURE_REMEDIATION.REDIS_CONNECTION_FAILED.fix.toLowerCase()).toMatch(/redeploy/);
  });

  it('REDIS_PROVISIONING_FAILED remediation mentions support and service limits', () => {
    const { fix } = FAILURE_REMEDIATION.REDIS_PROVISIONING_FAILED;
    expect(fix.toLowerCase()).toMatch(/support/);
    expect(fix.toLowerCase()).toMatch(/limit/);
  });

  it('exposes a valid severity + badge + dot mapping per code', () => {
    for (const code of FAILURE_CODES) {
      const { severity } = FAILURE_CODE_COPY[code];
      expect(['critical', 'warning']).toContain(severity);
      expect(FAILURE_SEVERITY_BADGE[severity]).toBeTruthy();
      expect(FAILURE_SEVERITY_DOT[severity]).toBeTruthy();
    }
  });

  it('maps critical codes to the destructive badge', () => {
    for (const code of FAILURE_CODES) {
      if (FAILURE_CODE_COPY[code].severity === 'critical') {
        expect(FAILURE_SEVERITY_BADGE[FAILURE_CODE_COPY[code].severity]).toBe('destructive');
      }
    }
  });

  it('falls back to UNKNOWN copy for an unrecognized code', () => {
    expect(failureCodeCopy('SOME_UNLISTED_CODE').label).toBe(FAILURE_CODE_COPY.UNKNOWN.label);
  });

  it('reads a stored code with no copy as UNKNOWN and keeps every known code', () => {
    expect(knownFailureCode('RDS_UNAVAILABLE')).toBe('UNKNOWN');
    for (const code of FAILURE_CODES) {
      expect(knownFailureCode(code)).toBe(code);
    }
  });
});

// ── §65 explanation fallback ────────────────────────────────────────────────

describe('§65 explanation fallback copy', () => {
  it('is jargon-free for when the AI explanation is unavailable', () => {
    expect(EXPLANATION_FALLBACK.why).not.toMatch(JARGON_PATTERN);
    expect(EXPLANATION_FALLBACK.fix).not.toMatch(JARGON_PATTERN);
  });
});

// ── §19 readiness verdicts ──────────────────────────────────────────────────

describe('§19 readiness verdicts', () => {
  it('defines exactly the 3 compatibility verdicts', () => {
    expect(COMPATIBILITY_VERDICTS).toEqual([
      'READY',
      'NEEDS_ATTENTION',
      'NOT_COMPATIBLE',
    ]);
  });
});

// ── Semantic readiness states ───────────────────────────────────────────────

describe('semantic readiness states', () => {
  it('defines exactly the 4 readiness states in order', () => {
    expect(READINESS_STATES).toEqual([
      'READY',
      'ALMOST_READY',
      'NEEDS_CHANGES',
      'ANALYSIS_INCOMPLETE',
    ]);
  });

  it('maps every state to a non-empty, jargon-free label', () => {
    for (const state of READINESS_STATES) {
      const presentation = READINESS_STATE_PRESENTATION[state];
      expect(presentation.label, `label for ${state}`).toBeTruthy();
      expect(presentation.label, `label for ${state}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('never says "Almost ready" while deployment is blocked', () => {
    expect(READINESS_STATE_PRESENTATION.ALMOST_READY.label).toBe('Action needed');
    expect(READINESS_STATE_PRESENTATION.NEEDS_CHANGES.label).toBe('Changes needed');
    expect(readinessStateHeading('ALMOST_READY', 1)).not.toMatch(/almost/i);
    expect(readinessStateHeading('NEEDS_CHANGES', 2)).not.toMatch(/almost/i);
  });

  it('maps every state to a jargon-free heading', () => {
    for (const state of READINESS_STATES) {
      expect(readinessStateHeading(state, 2), `heading for ${state}`).toBeTruthy();
      expect(readinessStateHeading(state, 2), `heading for ${state}`).not.toMatch(JARGON_PATTERN);
    }
  });

  it('readinessStateHeading reads out the change count for blocked states', () => {
    expect(readinessStateHeading('READY', 0)).toBe('Ready to deploy');
    expect(readinessStateHeading('ANALYSIS_INCOMPLETE', 0)).toBe('Checking deployment readiness…');
    expect(readinessStateHeading('ALMOST_READY', 1)).toBe('1 change needed before deployment');
    expect(readinessStateHeading('NEEDS_CHANGES', 2)).toBe('2 changes needed before deployment');
  });

  it('readinessChangesHeading singularizes and pluralizes the change count', () => {
    expect(readinessChangesHeading(1)).toBe('1 change needed before deployment');
    expect(readinessChangesHeading(2)).toBe('2 changes needed before deployment');
  });

  it('readinessChecksLabel is a check count, never a percentage', () => {
    expect(readinessChecksLabel(4, 6)).toBe('4 of 6 checks passed');
    expect(readinessChecksLabel(6, 6)).toBe('6 of 6 checks passed');
    expect(readinessChecksLabel(1, 3)).not.toMatch(/%/);
  });

  it('assigns the correct tones per state', () => {
    expect(READINESS_STATE_PRESENTATION.READY.tone).toBe('ready');
    expect(READINESS_STATE_PRESENTATION.ALMOST_READY.tone).toBe('attention');
    expect(READINESS_STATE_PRESENTATION.NEEDS_CHANGES.tone).toBe('incompatible');
    expect(READINESS_STATE_PRESENTATION.ANALYSIS_INCOMPLETE.tone).toBe('pending');
  });

  it('readinessStateFromVerdict maps every §19 verdict onto its state', () => {
    expect(readinessStateFromVerdict('READY')).toBe('READY');
    expect(readinessStateFromVerdict('NEEDS_ATTENTION')).toBe('ALMOST_READY');
    expect(readinessStateFromVerdict('NOT_COMPATIBLE')).toBe('NEEDS_CHANGES');
  });
});

// ── §42 onboarding steps ────────────────────────────────────────────────────

describe('§42 onboarding steps', () => {
  it('defines the six steps in exact order', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'Connect GitHub',
      'Choose repository',
      'Analyse',
      'Fix compatibility issues',
      'Create test deployment',
      'Ready for customer deployment',
    ]);
  });
});

// ── §31 secret mask ─────────────────────────────────────────────────────────

describe('§31 secret mask', () => {
  it('is the canonical mask value', () => {
    expect(SECRET_MASK).toBe('***');
  });

  it('is a non-empty string', () => {
    expect(SECRET_MASK.length).toBeGreaterThan(0);
  });
});

// ── §65 copy principles ─────────────────────────────────────────────────────

describe('§65 copy principles', () => {
  it('documents all five §65 rules', () => {
    expect(COPY_RULES_65.JARGON_FREE_TOP_LEVEL).toBe(true);
    expect(COPY_RULES_65.EXPANDABLE_TECHNICAL_DETAIL).toBe(true);
    expect(COPY_RULES_65.NO_RAW_AWS_TERMS_AT_TOP_LEVEL).toBe(true);
    expect(COPY_RULES_65.HONEST_TRUST_STORY).toBe(true);
    expect(COPY_RULES_65.MASKED_SECRETS).toBe(true);
  });

  it('JARGON_PATTERN matches all known raw AWS terms', () => {
    expect('CloudFormation').toMatch(JARGON_PATTERN);
    expect('IAM').toMatch(JARGON_PATTERN);
    expect('ECS').toMatch(JARGON_PATTERN);
    expect('ALB').toMatch(JARGON_PATTERN);
    expect('Lambda').toMatch(JARGON_PATTERN);
    expect('VPC').toMatch(JARGON_PATTERN);
    expect('CFN').toMatch(JARGON_PATTERN);
    expect('RDS').toMatch(JARGON_PATTERN);
  });

  it('JARGON_PATTERN does not match product-language terms', () => {
    expect('Healthy').not.toMatch(JARGON_PATTERN);
    expect('Installing').not.toMatch(JARGON_PATTERN);
    expect('Deployment failed').not.toMatch(JARGON_PATTERN);
    expect('Database unreachable').not.toMatch(JARGON_PATTERN);
    expect('Helper disconnected').not.toMatch(JARGON_PATTERN);
  });
});
// §61 recoverability + the one customer-facing stack-status phrase.
describe('recoverability and customer stack status label', () => {
  it('classifies every failure code', () => {
    for (const code of FAILURE_CODES) {
      expect(FAILURE_RECOVERABILITY[code], `recoverability for ${code}`).toBeDefined();
    }
  });

  it('recoverability copy is jargon-free', () => {
    for (const copy of Object.values(RECOVERABILITY_COPY)) {
      expect(copy).not.toMatch(JARGON_PATTERN);
    }
  });

  it('points every DEPLOYZ_ACTION fix at support, never at a retry the dashboard does not offer', () => {
    for (const code of FAILURE_CODES.filter((c) => FAILURE_RECOVERABILITY[c] === 'DEPLOYZ_ACTION')) {
      const { fix } = FAILURE_REMEDIATION[code];
      expect(fix, code).toMatch(/^Contact Deployz support/);
      expect(fix, code).not.toMatch(/\bretry\b|deploy (it|again)/i);
    }
  });

  it('falls back to the UNKNOWN class for unlisted codes', () => {
    expect(failureRecoverability('NOT_A_CODE')).toBe(FAILURE_RECOVERABILITY.UNKNOWN);
    expect(failureRecoverability('AWS_SCP_BLOCKED')).toBe('USER_ACTION');
  });

  it('maps every raw CloudFormation status shape to a jargon-free phrase', () => {
    const samples = [
      'ROLLBACK_COMPLETE',
      'CREATE_FAILED',
      'DELETE_FAILED',
      'UPDATE_ROLLBACK_COMPLETE',
      'CREATE_IN_PROGRESS',
      'DELETE_IN_PROGRESS',
      'CREATE_COMPLETE',
      'SOMETHING_ELSE',
    ];
    for (const raw of samples) {
      const label = customerStackStatusLabel(raw);
      expect(label).not.toMatch(JARGON_PATTERN);
      // Never the raw enum-style value itself.
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
    expect(customerStackStatusLabel('ROLLBACK_COMPLETE')).toBe('Setup was rolled back');
    expect(customerStackStatusLabel('DELETE_FAILED')).toBe('Removal was blocked');
  });
});

// ── §65 relay verification checks ───────────────────────────────────────────

describe('relay check copy', () => {
  it('maps every RELAY_CHECK_NAMES entry to non-empty, jargon-free copy', () => {
    for (const name of RELAY_CHECK_NAMES) {
      const copy = RELAY_CHECK_COPY[name];
      expect(copy.label, `label for ${name}`).toBeTruthy();
      expect(copy.passed, `passed for ${name}`).toBeTruthy();
      expect(copy.failed.problem, `failed.problem for ${name}`).toBeTruthy();
      expect(copy.failed.nextAction, `failed.nextAction for ${name}`).toBeTruthy();

      expect(JARGON_PATTERN.test(copy.label)).toBe(false);
      expect(JARGON_PATTERN.test(copy.passed)).toBe(false);
      expect(JARGON_PATTERN.test(copy.failed.problem)).toBe(false);
      expect(JARGON_PATTERN.test(copy.failed.nextAction)).toBe(false);
      if (copy.notRequired !== undefined) {
        expect(JARGON_PATTERN.test(copy.notRequired)).toBe(false);
      }
    }
  });

  it('the fallback copy is non-empty and jargon-free', () => {
    expect(RELAY_CHECK_FALLBACK_COPY.label).toBeTruthy();
    expect(RELAY_CHECK_FALLBACK_COPY.passed).toBeTruthy();
    expect(RELAY_CHECK_FALLBACK_COPY.failed.problem).toBeTruthy();
    expect(RELAY_CHECK_FALLBACK_COPY.failed.nextAction).toBeTruthy();
    expect(JARGON_PATTERN.test(RELAY_CHECK_FALLBACK_COPY.label)).toBe(false);
    expect(JARGON_PATTERN.test(RELAY_CHECK_FALLBACK_COPY.passed)).toBe(false);
    expect(JARGON_PATTERN.test(RELAY_CHECK_FALLBACK_COPY.failed.problem)).toBe(false);
    expect(JARGON_PATTERN.test(RELAY_CHECK_FALLBACK_COPY.failed.nextAction)).toBe(false);
  });

  it('relayCheckCopy looks up known names and falls back for unknown ones', () => {
    for (const name of RELAY_CHECK_NAMES) {
      expect(relayCheckCopy(name)).toBe(RELAY_CHECK_COPY[name]);
    }
    expect(relayCheckCopy('anything-else')).toBe(RELAY_CHECK_FALLBACK_COPY);
  });
});

describe('releaseBuildFailureSummary (Phase 8)', () => {
  it('maps the worker failure reason onto plain words and never names the build service', () => {
    const cases: [string | null, string][] = [
      ['CodeBuild reported FAILED — POST_BUILD: COMMAND_EXECUTION_ERROR: docker push denied', 'The version was built but could not be stored in the image registry.'],
      ['CodeBuild reported FAILED — BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: docker build', 'The version could not be built from the repository.'],
      // A metered base-image pull is not the application's fault, so it must
      // not read as one. It is tested against the BUILD phase context it
      // really arrives with, which would otherwise match the generic branch.
      [
        'CodeBuild reported FAILED — BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: if [ "$(cat /tmp/deployz-build-outcome)" = rate_limited ]; then echo "Docker Hub rate limit (HTTP 429) blocked the base image download" >&2; exit 1; fi',
        'The container registry temporarily limited image downloads. Start the build again in a few minutes.',
      ],
      // The final check names no cause: the summary must not blame the repository.
      [
        'CodeBuild reported FAILED — BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: if [ "$(cat /tmp/deployz-build-outcome 2>/dev/null)" != ok ]; then echo "The image build did not produce an image" >&2; exit 1; fi. Reason: exit status 1',
        'The image build failed. This message does not show the cause.',
      ],
      ['Failed to fetch repo tarball for acme/site (ref: sadsad22): HTTP 404 — 404: Not Found', 'The build could not fetch the repository.'],
      ['CodeBuild reported TIMED_OUT', 'The version build ran out of time.'],
      ['CodeBuild reported FAILED — DOWNLOAD_SOURCE: CLIENT_ERROR', 'The build could not fetch the repository.'],
      ['CodeBuild reported FAILED — PROVISIONING: fault', 'The build could not start.'],
      ['CodeBuild reported FAILED', 'The version build failed.'],
      [null, 'The version build failed.'],
    ];
    for (const [reason, expected] of cases) {
      const summary = releaseBuildFailureSummary(reason);
      expect(summary).toBe(expected);
      expect(summary).not.toMatch(JARGON_PATTERN);
      expect(summary).not.toMatch(/CodeBuild/i);
    }
  });
});

describe("failed-update remediation", () => {
  it("does not claim the running release is serving; the deployment page states measured health", () => {
    expect(FAILURE_REMEDIATION.ECS_DEPLOYMENT_FAILED.fix).not.toMatch(/serving traffic/i);
  });
});
