# Deployz launch-readiness audit (public pilot)

Date: 2026-11-06. Branch: `claude/deployz-launch-audit-80a8c1` (commit 70666adf).
Scope: static review of six tracks by read-only reviewers. Billing and legal are out of scope.
Status of evidence: items marked **Verified** were re-read in code by the orchestrator. All other items are reviewer claims from code reading. Items marked **Unverified** need a live check. No tests and no AWS runs have happened yet.

## Verdict

**NO-GO for a public pilot until the blockers below are closed.** The core design holds: relay isolation, tenant isolation, the customer code flow, and the IAM boundary all looked sound. The gaps are small guards and operating readiness, and most fixes are small.

## Blockers (fix before pilot)

| ID | Track | Finding | Evidence | Fix |
|---|---|---|---|---|
| B1 | Reliability | `relay/reset` has no state guard. It can move a DELETED or DELETING deployment back to NOT_INSTALLED. A DELETING one can get stuck. A DELETED one can be reinstalled without billing. **Verified**: no state check in `performRelayReset` or its route. Downstream effects not re-traced. | `apps/api/src/server.ts:7421-7518`; admin route `admin/routes.ts:510` | Return 409 for DELETING and DELETED. Add a test for each. |
| B2 | Reliability | A DESTROY on a connected but wedged relay has no escape. Force-complete needs a disconnected relay or two failed destroys. | `packages/cdk/src/lambda/worker.ts:861`; `server.ts:7087`, `:7122` | Open force-complete when the DESTROY has been active 60 minutes or more and has 3 re-offers. |
| B3 | Reliability | A re-offered INSTALL or CONFIG_UPDATE can run with masked secrets (`***`) after a lost claim response. | `apps/api/src/claimed-payload.ts:34-50`; `server.ts:9302-9311`; `worker.ts:824-833` | Relay refuses a masked value. Control plane regenerates secrets on re-offer. A CONFIG_UPDATE without secret values must fail. |
| B4 | Security | GitHub App binding accepts a "fresh install" (15 minutes) with no proof of ownership, and the setup route has no rate limit. **Verified** in code: a new binding passes on `isFreshInstallation` alone. It needs a valid signed state, which any signed-in vendor can start. Real exposure is an abandoned install within the window. It is narrower than the reviewer said, but cheap to close. | `server.ts:4072-4082`; `github.ts:606-611` | Shorten the window to about 1 minute and add a rate limit on `/api/github/setup`. Prefer requiring the OAuth `code`. |
| B5 | Ops | Production has no approval gate and no PR CI. The docs say this holds "until public launch". Live GitHub settings **Unverified**. | `docs/operations/control-plane.md:125-130`; `docs/decisions/README.md:52-55`; `ci.yml:3-11` | Required reviewers on the `production` environment. Restore PR CI. Code-owner review on main. |
| B6 | Ops | No documented or tested restore for the control-plane database. It is single-AZ. | `packages/cdk/src/deployz-stack.ts:120-135` | Write a restore runbook. Do one restore drill. Decide on Multi-AZ. Keep 14 days of backups. |
| B7 | Ops | Rollback ignores forward-only migrations. An old API on a newer schema can crash. | `control-plane.md:148-156`, `:283-303` | Rule: migrations must be expand-only. A destructive change takes two releases. Add a PR checklist item. |
| B8 | Networking/Auth | The production cookie domain `.deployz.dev` covers customer hostnames (`d-<id>.deployz.dev`). A signed-in vendor who opens a customer app can send the session cookie to code the vendor controls. The docs call this a known gap. Severity depends on whether vendors are untrusted. For a public pilot, treat as a blocker. | `docs/networking-and-https.md` "Known gap" | Finish the cutover to `API_BROWSER_DOMAIN_NAME` (`.app.deployz.dev`). |

## Should fix before pilot (high value, low cost)

Security
- S1. Email 2FA has no account lockout, and a resend resets the attempt counter. Only per-IP limits apply. (`auth.ts:12-19`, `server.ts:8576-8577`)
- S2. Rate limits are per Lambda container. Add a database store for Better Auth. (`server.ts:2456`)
- S3. Missing `BETTER_AUTH_SECRET` falls back to public default keys. Fail at start on Lambda. (`customer-access.ts`, `install-link-token.ts:14`, `env.ts:89`)
- S4. Fixture modes (sign-in codes in responses) have no runtime guard in production. Fail at start on Lambda if any `*_FIXTURE_MODE` is true. (`env.ts:292-324`)
- S5. PURGE has no server-side confirmation. **Verified**: the route reads no body. It is limited to owner or admin on a DELETED deployment. Require `confirmName`. (`server.ts:7263`)
- S6. Control-plane secrets are plaintext Lambda environment variables. Limit who can read them. (`deployz-stack.ts:642-690`)

Reliability
- S7. CONFIG_UPDATE and DEPLOY can wait on each other for about 2 hours on a configured first start. (`server.ts:9261-9275`)
- S8. Vendor retry-install can cancel a live INSTALL older than 30 minutes. (`server.ts:7568-7634`)
- S9. DESTROY can delete a retained database for an install that succeeded in AWS but not in the database. Data-loss class. (`server.ts:6984-6992`; `packages/relay/src/destroy.ts:219`)
- S10. Heartbeat writes HEALTHY with no state guard. (`server.ts:10379-10396`)
- S11. RESTART success always sets HEALTHY, even from FAILED. (`server.ts:2200-2205`, `:9610-9618`)
- S12. A relay `register` can change the install id of an installed deployment. (`server.ts:9107`)

Analysis
- S13. Accuracy: about 97% on the tuned corpus but 70-83% on blind sets. About 7-10% of blind repos get a too-lenient verdict. The docs' zero-false-deployable gate is not met. Tell vendors the verdict is a prediction.
- S14. Confirm the production `ANALYSIS_ENGINE`. The workflow defaults to `rules`. The repository variable could not be read. **Unverified**. (`.github/workflows/deploy-api.yml:232`)
- S15. No rate limit or spend cap on `/api/applications/:id/analyse` and `fix-instructions`. The "Explain with AI" route has one. (`server.ts:4775`, `:5004`)
- S16. Secret redaction before repo text goes to the AI provider misses lowercase and JSON keys and common vendor key prefixes. (`packages/analysis/src/redact.ts:12-33`)
- S17. A vendor who wrongly answers "not used" on a volume or local-state finding can lose data. Show a data-loss warning.

Operations
- S18. Alarms miss stuck jobs, relay loss, queue age and DB CPU. Alerts go to one optional email. No on-call. (`deployz-stack.ts:495-585`)
- S19. No WAF. Only a global 100 rps throttle. (`deployz-stack.ts:469-470`)
- S20. Logs are kept 7 days. Use 30 days. (`api-lambda.ts:48`, `worker-lambda.ts:49`)
- S21. No status page and no incident process. Add a hosted status page, a short incident doc, and a support email.
- S22. No secret-rotation procedure. Name a second admin with AWS and GitHub access.

Pilot scope and cost
- S23. Expose only Regions with evidence. Suggested: us-east-1, us-east-2, us-west-2, eu-west-1, eu-central-1. Run the stateless canary once in each new Region. Do not expose sa-east-1.
- S24. Medium and Large are not certified on real AWS. Default and minimum the pilot to Small, or certify them.
- S25. SQS and EventBridge Scheduler are uncertified. Qualify on real AWS or hide them.
- S26. The cost estimate is about $10 a month low (public IPv4, secrets, alarm, logs). Add it to the ALB and NAT ranges. (`packages/contracts/src/pricing.ts:57-61`)
- S27. Check the Cloudflare zone mode is Full (strict). Document the 100-second timeout and upload limit. **Unverified**.
- S28. A failed ACM certificate is not replaced on retry, so the first install cannot recover.

UX
- S29. The failed-install page says "Your software provider has been notified", but nothing notifies the vendor. (`apps/web/src/components/install-progress.tsx:441-442`)
- S30. A stuck customer has no vendor contact address.
- S31. Vendors are not told which email the customer must use to sign in. (`invitation-form.tsx:200-210`)
- S32. No error boundary on the root, install, or dashboard routes.
- S33. No 2FA recovery path for a vendor who loses their mailbox. Add a runbook line.
- S34. Docs name buttons and badges that do not exist. Update `user-flows.md` and `installation-invitations.md`. Update the "verified" date in `docs/README.md`.

## Notes (accept for pilot, record)

- Single NAT per deployment. Cache has no TLS. Staging shares the production account.
- A third party can lock a customer out of sign-in for one hour (10 wrong codes).
- The legacy deploy link needs no email proof. Repo commands run unsandboxed in the customer account (documented).
- A migration can run twice if the relay dies between RunTask and the marker write. The docs say "once".
- Env detection reads only the first 200 source files.
- Cloudflare record sweep is capped at 300. Orphan validation records are not swept.
- ECR has no lifecycle policy. A corrupt stored size profile falls back to Small instead of failing closed.
- Customer vocabulary mixes "publisher" and "software provider".

## Verified as sound

Relay is egress-only with hashed single-use tokens. Tenant isolation holds on vendor routes. Customer code flow is strong (8 digits, HMAC, atomic attempts, 10-minute expiry). IAM uses a permissions boundary. Team Admin support mode is read-only and audited. KMS cipher fails closed. Failed-update semantics, operation exclusivity and reconcile-before-fail hold in the code read. The deploy pipeline is CI-only with OIDC, a readiness poll and termination protection.

## Not covered

Dependency vulnerabilities. Mobile layout and accessibility in a browser. The worker and watchdog Lambda internals. About 2,500 lines of relay code. Live AWS, GitHub and Cloudflare settings. Penetration testing. Billing and legal.

## Next steps

1. Fix B1-B4, then add the tests named in the reliability review.
2. Confirm live settings: `production` environment protections, `ALERT_EMAIL`, `ANALYSIS_ENGINE`, Cloudflare zone mode, `DEPLOYABLE_AWS_REGIONS`.
3. Run simulated checks (`pnpm test:affected`, `pnpm e2e:scenarios`).
4. Real AWS (budget $10, one deployment at a time, stop at $8): stateless canary, queue + schedule shape, one non-default size, prod-like dry run, failure drills.
5. Re-review B5-B8 and the "should fix" list, then hold the go / no-go review.
