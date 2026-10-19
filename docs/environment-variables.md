# Environment variables setup

How detected environment variables become a vendor setup task, and how
their values reach release builds and customer deployments.

## Flow

1. **Analysis** detects variable **names** (never values) from code reads,
   `.env*` sample files and the external-service catalog
   (`packages/analysis/src/detectors.ts` `detectEnvVarModel`,
   `env-classification.ts`). An analysis that completes with variables is
   not a failure. Only a pipeline error sets `analysisStatus = FAILED`.
2. **Overview** shows **Configuration needs review** when a required
   detected variable has no vendor decision, or a vendor-provided required
   value is missing. The primary action is **Review configuration**
   (`/config#environment-variables`). Repository required changes still come
   first. When customer deployments exist, the state stays and a notice is
   added.
3. **Configuration → Environment variables**: the detected names are a
   draft. Each row starts from a suggestion (marked "Suggested"). Nothing is
   saved until the vendor saves. The same table lists every other vendor
   default. Rows are grouped, all expanded and never paged: Needs
   attention, Set by vendor, Set by customer, Managed by Deployz, Optional
   and uncertain. The vendor can bulk-classify rows.
4. **Save** stores the decisions (`PUT /api/applications/:id/environment-settings`)
   and vendor values (`PUT /api/applications/:id/config`, vendor scope). The
   page then reads readiness again. Saving never runs analysis again.
   Analysis runs again only when the repository or the commit changes.
5. **Release build**: required build-time values set by the vendor gate
   release creation (`422 BUILD_CONFIGURATION_MISSING`, also for the first
   release an install link creates).
6. **Install link**: customer-provided runtime values never block creating
   or sharing a link.
7. **Customer install page**: an **Application settings** section after the
   region and before the review. It shows only customer-provided runtime
   fields, with the vendor's label and help text. The technical name is
   secondary. Installation is refused while a required value is missing. A
   blank or whitespace-only value counts as missing and is not saved. The
   vendor's decision, not the browser, says which values are secret. The page
   trims leading and trailing spaces from a plain value; a secret, and every
   vendor value, is stored exactly as typed.

## Per-variable decision

Stored in `applications.environment_settings` (jsonb, nullable). Schema and
pure evaluation: `packages/contracts/src/environment-setup.ts`.

| Field | Values |
|---|---|
| When used | `build` or `runtime` |
| Required | yes / no (always no for "Optional / not needed") |
| Secret | yes / no |
| Who provides | Managed by Deployz · Set by vendor · Set by customer · Optional / not needed |
| Label, help | Customer-facing text, for "Set by customer" only |
| Managed value | Only for "Managed by Deployz" at runtime: a `binding` with a `resource` (`database`, `cache`, `storage`) and a `kind` |

Rules (server-validated):
- **Managed by Deployz** is allowed only for keys that Deployz really
  supplies: managed bindings (database, cache, storage, port, a provisioned
  queue and its dead-letter queue), the application's own public URL, and
  app-internal secrets that the relay generates. One exception: a setting
  with a managed value (see "Map a variable to a managed value") can use any
  valid variable name.
- **Set by customer** and **Managed by Deployz** are runtime only.
- A variable without a saved decision keeps the behaviour it had before
  this feature (legacy default). Existing applications keep working without
  migration.

Suggestions come from the analysis evidence (code reads, `.env.example`,
the service catalog) and show their source. Uncertain detections (sample
file only, low confidence) are marked **Uncertain**. Build-time suggestions
come from well-known name prefixes (`NEXT_PUBLIC_`, `VITE_`,
`REACT_APP_`, …). The vendor confirms them.

## Map a variable to a managed value

Some apps read their database connection through a name that analysis cannot
see (for example `GF_DATABASE_URL` from an ini override, `MM_SQLSETTINGS_DATASOURCE`,
or a name that a config library builds). When Deployz provisions a managed
database and no standard or detected name has evidence of a read, the
manifest has `database.connectionUnverified`. The readiness gate then reports
`database-connection-unverified` and the state is **Needs configuration**.
No deployment starts, because the app would connect to nothing or to an
embedded default.

To resolve it, in **Configuration → Environment variables**:

1. Choose **Managed by Deployz** for the variable that the app reads, or use
   **Add managed value** to enter a name that analysis did not detect.
2. In **Value**, choose the managed value: Database URL, Database host,
   Database port, Database name, Database user, Database password, JDBC URL,
   Redis URL, Redis host, Redis port, or Bucket name. The list shows only the
   resources that the application has.
3. Save.

The saved setting has `binding: { resource, kind }`. The kind must fit the
resource: database `url`, `host`, `port`, `database`, `username`, `password`,
`jdbc_url`; cache `url`, `host`, `port`; storage `bucket`. The server refuses
a managed value for a non-Deployz provider, for the build stage, and for a
resource that the application does not have. A mapped name counts as provided
for the required-variable checks. The relay does not generate a value for it.
A mapped database value clears `connectionUnverified`. The mapping applies
to new deployments and to the next preflight. A running deployment keeps its
frozen manifest.

## Defaults, derived values and precedence

- **Sample files are evidence, not defaults.** A value in `.env.example`,
  `.env.sample` or `.env.template` names the variable, but it never reaches
  the container. It does not make a required read optional. Only a real
  (non-placeholder) value in a runtime env file (`.env`, `.env.production`)
  or an inline fallback in the code is a default.
- **Some reads are never required.** A variable the runtime source assigns
  itself (`process.env.X = ...`), a `createEnv` `runtimeEnv` pass-through
  (`KEY: process.env.KEY`), and a key that a zod schema declares
  `.optional()` or `.default()` are not required, whatever other bare reads
  exist. A read in a test, `e2e`, `playwright`, `storybook`, `docs` or
  `examples` folder, and a read in a `client`, `frontend` or `ui` folder, is not
  required. A Ruby `ENV.fetch("X") { default }` has a default. A key that the
  same file tests for presence (also `typeof process.env.X`) is not required,
  and `delete process.env.X` is not a read. A bare `ENV['X']` in a Rails
  `config/storage.yml` service block is not required: Rails builds that
  service only when the app selects it. A zod schema that the code parses
  only inside a function is checked when its feature runs, not at boot.
- **Weak reads.** A bare read (an argument, a stored value, a config-file
  lookup) only proves that the app reads the key. It does not make a key
  required when the key is a tuning value (a name with `LIMIT`, `MAX`, `SIZE`,
  `TIMEOUT`, `INTERVAL`, `ENABLED`, `LEVEL`, an `ALLOW_`, `SHOW_` or `USE_`
  prefix, and similar), or when it is a credential of an optional integration
  (mail, error and usage monitoring, chat, social login) that the repository
  does not evidence as a service SDK. A key that a boot guard, a schema without
  default, an `assert` helper, `ENV.fetch` without default, or a Go `required`
  tag needs stays required. A throw guard inside a request handler, or on a
  feature switch (`*_ENABLED`), is not a boot guard.
- **Client build-time names.** `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` and
  `PUBLIC_*` names are inlined at build time. A bare read of one does not
  make it required, unless it is the application's own address
  (`NEXT_PUBLIC_BASE_URL`). That name stays a customer value and is never
  derived.
- **Compose build args.** A Dockerfile `ARG NAME` with no default that a
  production compose file sets to a literal value under `build.args` is a
  required **build** variable. The compose value is shown as evidence (not
  for secret-looking names); the vendor enters the value. A Dockerfile `ARG`
  that no compose file sets, a value that compose only forwards from the
  environment (`${NAME}`), and an arg in a test or `e2e` compose file are not
  required.
- **Sibling apps are out of scope.** When the Dockerfile sits in `apps/<name>/`,
  reads in another `apps/<other>/` directory do not count, unless a production
  compose file (`docker-compose.yml`, `compose.yml`) or a Procfile points at it,
  or the Dockerfile names it. A sibling with only its own Dockerfile is a
  separate image (a release has one image), so it does not count. Comment
  lines and build-override compose variants are not references.
- **Boot guards make a key required.** A key that the code refuses to start
  without (`if (!env.KEY) throw`, or the same test limited only by "not in
  mode X", such as `env.DEPLOY_MODE !== "desktop" && !env.KEY`) is required,
  even when its zod schema says `.optional()`. A guard that applies only in a
  named mode (`env.CLOUD_MODE && !env.KEY`) or only outside production does
  not count. Shared `packages/*` still count. A non-secret value
  passed alone to a named converter (`Boolean(...)`, `formatBaseUri(...)`) is
  not required; `Number(...)` and `String(...)` are not converters in this sense.
- **Deployz-derived S3 values.** When Deployz provisions storage and the app
  reads an S3 region or endpoint variable in code (`S3_REGION`,
  `S3_ENDPOINT`, `S3_ENDPOINT_URL`, `AWS_S3_ENDPOINT`, `*_S3_REGION`), the
  variable is **Managed by Deployz**. `GET /api/relay/config` serves it as a
  `derived` plain value: the deployment Region, or
  `https://s3.<region>.amazonaws.com`. The template already injects
  `AWS_REGION` and the bucket names.
- **App-specific binding names.** Deployz sets its managed database, cache
  and bucket values under the names the app reads. Analysis finds these names
  from code reads, `.env.example` files at any depth inside the selected app
  (not in docs, examples or sibling apps), Prisma `datasource` blocks
  (`url`, `directUrl`, `shadowDatabaseUrl`, whatever the variable is called),
  and framework config files: Rails `config/*.yml`, Laravel `config/*.php` and
  Spring `application*.properties|yml` (a `spring.datasource` property means
  the app reads `SPRING_DATASOURCE_*`). A config-file read without a default
  is required only for a secret name. JDBC names (`*_DATASOURCE_URL`,
  `*_JDBC_URL`) get a JDBC URL. A Redis name that ends in `REDIS_URL`,
  `REDIS_URI`, `REDIS_DSN`, `REDIS_HOST` or `REDIS_PORT`, or a prefixed name
  that ends in `_REDIS` (`PAPERLESS_REDIS`, a URL), is bound only when Redis
  is required. A name with a switch word (`ENABLE`, `USE`, `WITH`, `HAS`,
  `DISABLE`, `NO`, `SKIP`) is never a binding. `REDIS_PASSWORD` is never
  bound.
- **Selectors must be set.** A selector is an env variable that picks the
  database engine (`DB_TYPE`, `DATABASE_CLIENT`, `DB_CONNECTION`,
  `*_DBENGINE`, `<APP>_DRIVER` with an engine default) or the file storage
  (`STORAGE_TYPE`, `ACTIVE_STORAGE_SERVICE`, `UPLOAD_PROVIDER`,
  `<APP>_FILES_TYPE`, `DATASOURCE_TYPE`). When its
  default (code, config file, sample or compose value) is an embedded engine
  (`sqlite`, `h2`, …), a different engine, or local disk, and Deployz
  provisions the managed resource, the selector is **required**. The app
  would otherwise store data on the container disk. The source line shows the
  value to use (`pg`, `s3`, …) when the code or a sample file shows it. A
  selector whose default already names the provisioned engine, or whose
  resource is not provisioned, is not required. The default can come from the
  selected Dockerfile `ENV` (it wins over a code default), an env defaults map
  (`env.ts`), a `@Env('X') field = 'sqlite'` config class, a typed viper key,
  a NestJS `get('X', 'local')` or a Django-environ `env.str('X', …)` read. A
  YAML `config.yml` that reads an engine selector as `$(DB_TYPE)` with no
  default also makes it required. A runtime env sample value counts as the
  default when the fetched tree never reads the selector. A selector read
  through a config table (`env('datasource.type', 'DATASOURCE_TYPE')`) or
  named by a Go string constant, with no default found, is required too: the
  choice is undecided. When the code shows no S3 value, the source line asks
  for a value that stores files outside the container.
- **S3 switched on by presence.** When the app builds its S3 client only if
  several variables are all set (`A && B && C ? new S3(…)`), each of them that
  Deployz does not bind or derive is required: otherwise the files go to the
  container disk. These variables are never generated secrets.
- **Deployz-derived public URL.** When the app reads its own public URL with
  no default, the variable is **Managed by Deployz**. The names are
  `PUBLIC_URL`, `APP_URL`, `BASE_URL`, `SITE_URL`, `ROOT_URL`, `WEB_URL`,
  `APP_BASE_URL`, `PUBLIC_ORIGIN`, `ORIGIN`, `NEXTAUTH_URL`, `AUTH_URL`,
  `SITE_ROOT`, and `<APP>_PUBLIC_URL`, `<APP>_BASE_URL`, `<APP>_APP_URL`,
  `<APP>_SITE_URL`, `<APP>_ROOT_URL`, `<APP>_EXTERNAL_URL`.
  `GET /api/relay/config` serves it as a `derived` plain value: the default
  HTTPS URL of the deployment, `https://d-<deploymentId>.deployz.dev`. A
  provider-prefixed name (`OPENAI_BASE_URL`, `S3_PUBLIC_URL`), a client
  build-time name, a variable whose sample value is a path (`BASE_URL=/app`),
  and a variable that only browser code reads are not derived. They stay
  **Set by customer**. Any other URL variable also stays **Set by customer**.
- **Precedence:** explicit vendor or customer value > Deployz-derived value >
  analysis evidence (sample values, suggestions). A derived value never
  replaces an explicit value.
- **The saved decision selects the source** (`deliversConfigValue`). "Set by
  vendor" delivers the vendor default, or the vendor's override for one
  customer. "Set by customer" delivers only that customer's value, never a
  vendor default. "Managed by Deployz" and "Optional / not needed" deliver no
  saved value. A value saved under an earlier decision therefore never
  overrides the new source. The preflight counts a value as provided only by
  the same rule. A key with no saved decision keeps the legacy rule: every
  saved value is delivered.
- **Generated secrets** (`mintedEnvKeys`). With a saved decision, the relay
  mints a key only when it is "Managed by Deployz" and an app-internal
  secret. Without a decision, it mints `deployz_generated` keys: a required
  secret with a generatable name, or an optional internal secret with a
  generatable name (it usually falls back to a development default). An
  optional secret such as an ACME HMAC key or an analytics project key is
  never minted: a random value turns on a feature that the app then rejects.
- **Credentials:** Deployz never creates AWS access keys or IAM users, and
  never derives a public bucket URL (`S3_PUBLIC_BASE_URL`). The AWS SDK gets
  credentials from the ECS task role through the default credential chain.
  So the SDK credential names `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
  and `AWS_SESSION_TOKEN` are always optional: the vendor is never asked for
  them.
  An app that requires static keys (`S3_ACCESS_KEY_ID`) needs a vendor or
  customer value, or a code change to use the default chain.

## Where values go

Both secret paths below share one `SecretCipher` seam
(`apps/api/src/pending-secrets.ts`): a KMS-backed cipher in production
(`DEPLOYZ_KMS_KEY_ARN`, the control-plane key `alias/deployz-config-secrets`),
an in-memory stub in local dev/tests only. In AWS Lambda a missing or
invalid key fails closed; the stub is never used there. See
`docs/pending-secret-delivery.md` for the cipher contract and the
legacy-row migration. Neither path
ever returns plaintext from an API except the relay's own authenticated
`GET /api/relay/config` read.

| Value | Stored | Reaches |
|---|---|---|
| Vendor plain value | `application_configs.value` | Build: worker decrypts (trivially, not a secret) and passes it to CodeBuild as an environment var + `--build-arg NAME`. Runtime: served on `GET /api/relay/config`, applied by the post-install CONFIG_UPDATE executor and by the update each vendor save starts. |
| Vendor secret | `application_configs.encrypted_value` — ciphertext from `SecretCipher.encrypt`, deterministic context (`organizationId` + `applicationId` + `key` + `scope: 'vendor'`, never stored) | Build: the worker decrypts with the same cipher (`listVendorValues`) before handing CodeBuild the build args. Runtime: the relay's `GET /api/relay/config` decrypts it the same way (`readVendorSecret`) and serves the plaintext over that authenticated channel only — never in a job payload. |
| Customer value (install page) | DEPLOY-027 pending-secret vault (`pending_secrets` table, see `docs/pending-secret-delivery.md`) — staged before a deployment exists, bound to a deployment once one does | The relay's `GET /api/relay/config` decrypts the bound row and applies it via the post-install CONFIG_UPDATE executor. |
| Customer override (vendor edits) | Customer-scope `application_configs` row (masked; plaintext never stored — it rides the relay write-through/pending-secret vault instead) | That customer's running deployment (CONFIG_UPDATE write-through), or the pending-secret vault when no relay can act on it yet. |

- Secret values are never returned by a vendor-facing API, logged, written
  to events or telemetry, or sent to an AI prompt. The one plaintext-bearing
  response is the relay's authenticated `GET /api/relay/config` read. One
  exception to "not in the job payload": a CONFIG_UPDATE for a deployment
  whose relay is **already connected** carries the new values through SQS
  and `deployment_jobs.payload` until the relay claims the job, after which
  the stored payload is redacted (`docs/pending-secret-delivery.md`,
  *Accepted plaintext paths*). Values for deployments without a relay go
  through the encrypted vault instead.
- A vendor secret saved before encrypted storage existed has no value that
  Deployz can deliver. The page flags it **Re-enter this secret**, and it
  does not count as provided.

## Effect of later edits

- Build values apply to **new release builds**. A release image never
  changes after it is built.
- A saved vendor runtime value, or a removed one, reaches every running
  deployment of the application within a few minutes: one configuration
  update per customer whose relay is connected. The update succeeds only
  after the new tasks are running and healthy. If ECS rolls it back, the
  previous configuration revision keeps serving and the update shows as
  failed; secret values it already saved stay in the customer's secret
  store and are not rolled back. Save the corrected value again to retry. A removed vendor default
  leaves a deployment only when that customer has no override for the key.
  Vendor secret values do not travel in the queue; the relay reads them
  through its authenticated config endpoint.
- Saving decisions (who provides a key) does not start an update.
- A customer-scope secret row keeps only a mask; its value lives in the pending-secret vault (24 hours) or in the customer's own secret store. The preflight counts such a key as provided only for the deployment it is checked against: when an unexpired pending-secret row is bound to that deployment, or when a finished configuration update of that same deployment named the key (job payloads keep key names). Before a deployment exists, only a reusable staged row counts. Another deployment of the same customer, or a key added after the last update, does not make it provided. A stale row (expired vault value, fresh deployment) is reported as a missing value, so the customer enters it again at install. The vendor value is never substituted for it.
- A deploy, a rollback and a restart change only the image. The runtime
  configuration of a deployment stays as it is, so an older release never
  changes the configuration, and a release does not reset it.
- A customer override that the vendor edits reaches that customer's running
  deployment.
- Known gap: when a decision changes so that a value is no longer delivered,
  the value stays on a deployment that is already running. Later
  configuration passes do not apply it again, but they do not remove it.
  Remove it with the customer override editor, or reinstall.

## Security notes

- A vendor runtime secret is written into each customer's AWS account. The
  account owner can read it. Masking in the Deployz UI does not change
  this. Use **Set by customer** for values that the customer must not see,
  or for credentials that the customer owns.
- Build values are baked into the release image. Anyone who can pull the
  image can possibly read them. They are also visible in the CodeBuild build
  record in the Deployz control-plane account.

## Unsupported (post-MVP)

- Customer-provided **build** values (a per-customer build does not exist).
- Per-customer different values for a vendor-provided variable, except
  through the existing customer-override editor.
- Detection of Dockerfile `ARG` names, and of variables read only
  indirectly (for example through a dynamic key or a config file that is
  loaded at runtime). The vendor can add these keys by hand in the values
  editor.
- Format validation beyond names ending in `_URL`/`_URI`, `_EMAIL`, `_PORT`.
