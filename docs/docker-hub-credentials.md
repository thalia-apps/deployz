# Docker Hub credentials for the release build

The release build pipeline (`packages/cdk/src/pipeline/build-pipeline.ts`)
runs a customer's `docker build` in the Deployz control-plane account.
Almost every customer Dockerfile starts `FROM` a Docker Hub image, so the
build pulls from Docker Hub before it pushes to ECR.

Docker Hub meters **anonymous** pulls per source address. The CodeBuild
project has no VPC configuration, so its builds leave AWS from a shared
address pool: the quota is shared with other AWS accounts, and a build can
be refused with HTTP 429 at a moment unrelated to this account's own pull
volume. Two repositories in the 2-repository pilot failed this way 40
minutes apart and both rebuilt cleanly the next morning (DEPLOY-018 in
`docs/testing/repository-deployment/findings.md`).

Authenticating moves the build onto this account's own metered quota.

## The secret

| | |
| --- | --- |
| Name | `deployz-codebuild` |
| Region | The same region as the control-plane stack (`us-east-1`) |
| Type | JSON |

Required keys — no others are read:

```json
{
  "username": "<Docker Hub account name>",
  "accessToken": "<Docker Hub access token>"
}
```

Use a Docker Hub **access token**, never an account password. A token is
scoped, is listed in the Docker Hub account, and can be revoked on its own.

CodeBuild resolves the two values when a build STARTS. A secret name that
does not resolve — a missing secret, the wrong region, a missing JSON key —
fails **every** build immediately, before any command runs.

## Turning it on

The wiring is opt-in for that reason. The stack passes the secret name to
the build pipeline only when it is given one. In production the name comes
from the repository variable `DOCKERHUB_SECRET_NAME`, read by
`.github/workflows/deploy-api.yml`; deploys run only from that workflow
(`docs/operations/control-plane.md`):

```bash
gh variable set DOCKERHUB_SECRET_NAME --body deployz-codebuild
gh workflow run deploy-api.yml --ref main -f environment=production
```

The dispatch must name the environment: the input defaults to `staging`, so a
run without it deploys staging.

For a local `cdk diff -c local=true`, `DOCKERHUB_SECRET_NAME=<name>` in the
environment or `-c dockerHubSecretName=<name>` has the same effect. With
neither, the pipeline synthesizes exactly as before: no credential
environment variables, no Secrets Manager policy, and anonymous pulls.

**To turn it off again** — the rollback if a credential stops working, since
a failed login fails every build in `pre_build`:

```bash
gh variable delete DOCKERHUB_SECRET_NAME
gh workflow run deploy-api.yml --ref main -f environment=production
```

Name the environment here too, for the same reason. The next deploy removes
both environment variables and the Secrets Manager statement, and builds
return to anonymous pulls. Verified 2026-09-10.

> Deploying the control-plane stack from a workstation can revert other
> production configuration. Read the deploy notes before running it.

## What the build role may do

One action on one secret:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:<account>:secret:deployz-codebuild-??????"
}
```

The six-character suffix Secrets Manager appends to every secret ARN is not
known at synthesis time, so the resource ends in the wildcard AWS documents
for name-addressed secrets. It still matches only this one secret.

The role gets no write, delete, rotate or `DescribeSecret` permission, and
no access to any other secret.

## Where the values are, and are not

The values reach the build as CodeBuild `SECRETS_MANAGER` environment
variables `DOCKERHUB_USERNAME` and `DOCKERHUB_ACCESS_TOKEN`.

- The CloudFormation template holds only the secret **name** and the JSON
  key names.
- The token reaches `docker login` on standard input
  (`--password-stdin`), so it is never an argument in the process list.
- CodeBuild prints the command text it runs. That text holds the variable
  names, never their values, because no command expands them into output.
  Do not add one: a command that echoes either variable would print the
  credential into the build log.
- The build logs out of Docker Hub in the build phase's `finally` block,
  which CodeBuild runs whether the phase passed or failed.

## Rotating the token

The token can be replaced without a deployment — CodeBuild reads the secret
at the start of each build.

1. Create a new access token in the Docker Hub account. Keep the old one.
2. Put the new value in the existing secret. Do not create a second secret,
   and do not change the key names:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id deployz-codebuild \
     --region us-east-1 \
     --secret-string file://<a local file holding the JSON>
   ```

3. Start one release build and confirm it reaches the build phase.
4. Delete the old token in Docker Hub.

Delete the local file afterwards. Do not pass the JSON on the command line,
where it enters the shell history.

## When a build fails

**`unauthorized: incorrect username or password`.** Check `username` before
the token — it is the field that is usually wrong.

`username` must be the **Docker Hub account name**, the one in
`hub.docker.com/u/<name>`. It is **not**:

- the name or description given to the access token in Docker Hub. Docker
  Hub lists tokens with a Description column; that is a label, not a login
  identity. Enabling this the first time failed twice for exactly this
  reason — the stored username was the token's description.
- an organisation name. An organisation cannot log in; use the account of a
  member that owns the token.
- an email address.

Prove the pair outside the pipeline before wiring it up — it takes seconds
and avoids a deploy cycle with every release build failing:

```bash
docker login -u <account name> docker.io
```

Paste the `dckr_pat_…` token at the password prompt. Only put a pair that
prints `Login Succeeded` into the secret.

If the username is right, the token is wrong, revoked or expired. Rotate it
as above.

**The build fails before any command output.** CodeBuild could not resolve
the environment variables: the secret is missing, is in another region, is
missing `username` or `accessToken`, or the role lost
`secretsmanager:GetSecretValue`. Check with:

```bash
aws secretsmanager describe-secret --secret-id deployz-codebuild --region us-east-1
```

**`The container registry temporarily limited image downloads. Retrying in
60s.`** A rate limit, being retried. The build retries the image build three
times, after 1, 3 and 8 minutes, and only for a rate limit — an ordinary
Dockerfile error still fails on the first attempt.

**`Docker Hub rate limit (HTTP 429) blocked the base image download`.** All
four attempts were metered. The release is recorded with the failure code
`build_registry_rate_limited`, not `build_failed`: this is a statement about
the registry, not about the repository, and the same commit usually builds
minutes later. If it happens with the credential configured, the account's
own quota is exhausted — check the Docker Hub plan.
