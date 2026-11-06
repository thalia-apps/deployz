# Incident response

How the Deployz team handles an incident in the control plane or in a
customer's deployment. Alarms are in
[`control-plane.md`](control-plane.md). Failure codes are in
[`troubleshooting.md`](troubleshooting.md).

## Severity levels

| Level | Meaning | Example | Target to start work |
| --- | --- | --- | --- |
| SEV1 | The control plane is down, data is lost or exposed, or a secret leaked | API 5xx alarm and `/health/ready` fails; database restore needed | At once |
| SEV2 | A main flow is broken for many customers | Deploys fail for all; relays disconnected for all | 1 hour |
| SEV3 | One customer is affected, or a feature is degraded with a workaround | One deployment stuck; an AI explanation fails | 1 working day |

When unsure, use the higher level. Change the level when facts change.

## Who acts

- The incident lead is the first administrator who accepts the alarm or the
  report. The lead owns the incident until a named person takes it over.
- The lead finds the cause, decides the fix, and posts the updates.
- A second administrator helps and reviews risky actions (a restore, a
  rollback, a secret rotation).
- Who is on call is an owner decision. Until it is made, the alarm email
  address is the route for alarms.

## Steps

1. **Accept.** Say in the team channel that you have the incident. Write the
   start time and the level.
2. **Contain.** Stop the harm first: roll back a bad release (see
   *Promotion, approval and rollback* in `control-plane.md`), or rotate a
   leaked secret (*Secret rotation*). Do not delete evidence: keep logs and
   rows.
3. **Update the status page** for SEV1 and SEV2 within 30 minutes of the
   start. State what customers see, not the cause. Update at least every
   hour. Close it when the fix is checked.
4. **Tell the customers and vendors** who are affected:
   - Send from the team support mailbox.
   - Say what happened, what is affected, what they must do (often
     nothing), and when the next update comes.
   - For a data or secret exposure, say what data, since when, and what you
     did. Ask the owner for legal advice before you send it.
   - Do not guess a cause or a time. Say "we do not know yet".
5. **Fix and check.** Check `/health/ready`, a sign-in, and one deployment
   page. Check that the alarms return to OK.
6. **Close.** Post the end time and the final state.

## Post-incident note

For every SEV1 and SEV2, and for any SEV3 that taught something, write a
short note within 5 working days. Keep it in the team's issue tracker, not in
`docs/`. Use these headings:

- What happened, with times (start, found, contained, fixed).
- What customers saw.
- The cause.
- What worked and what did not.
- Actions, each with one owner and a date.

Do not name people as the cause. Name the missing check or the missing guard.

## Owner tasks

These do not exist yet and are needed before a public launch:

- A hosted status page.
- A support mailbox.
- The on-call rota.
