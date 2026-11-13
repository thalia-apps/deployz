-- A separate migration: Postgres refuses to use an enum value in the
-- transaction that adds it. "I deleted it myself" used to set COMPLETE; the
-- audit event names the deployments it touched.
UPDATE "deployments"
SET "cleanup_state" = 'CONFIRMED_BY_OWNER'
WHERE "cleanup_state" = 'COMPLETE'
  AND "id"::text IN (
    SELECT "payload"->>'deploymentId'
    FROM "event_logs"
    WHERE "event_type" = 'deployment.cleanup_acknowledged'
  );
