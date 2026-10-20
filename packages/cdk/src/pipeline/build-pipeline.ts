/**
 * Build pipeline — CodeBuild project + private ECR repository.
 *
 * The pipeline is CONTROL-PLANE infrastructure (in the Deployz AWS account),
 * NOT customer-account infrastructure. The control plane Lambda fetches the
 * repository source using the GitHub App installation token, uploads it to an
 * S3 bucket, then triggers CodeBuild with the S3 source location.
 *
 * CodeBuild builds the Docker image and pushes it to a private ECR repository.
 * The image is pinned by its immutable `sha256:` digest, written to the
 * `releases.image_digest` column. Customer accounts pull the image via
 * cross-account ECR grants (see ecr-grants.ts).
 *
 * The pipeline is triggered via the `startBuild` API by the control plane
 * (not GitHub webhooks — the source is placed in S3 by the control plane).
 */
import { ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  BuildEnvironmentVariableType,
  BuildSpec,
  ComputeType,
  LinuxBuildImage,
  Project,
  type BuildEnvironmentVariable,
} from 'aws-cdk-lib/aws-codebuild';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import type { IRepository } from 'aws-cdk-lib/aws-ecr';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildPipelineProps {
  /** Bucket the control plane uploads repository tarballs to. */
  readonly sourceBucket: IBucket;
  /** ECR repository name (default: `deployz-images`). */
  readonly repositoryName?: string;
  /** CodeBuild compute type (default: SMALL). */
  readonly computeType?: ComputeType;
  /** Build timeout in minutes (default: 30). */
  readonly timeoutMinutes?: number;
  /** ECR repository removal policy (default: RETAIN). */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * Name of the Secrets Manager secret holding Docker Hub credentials, in
   * THIS stack's region. The secret must be a JSON object with `username`
   * and `accessToken` (a Docker Hub access token, never an account
   * password). Unset — the default — leaves the build pulling base images
   * anonymously, exactly as before.
   *
   * CodeBuild resolves a SECRETS_MANAGER environment variable when the build
   * STARTS, so a name that does not resolve fails every build immediately.
   * The wiring is therefore opt-in: it is turned on only once the secret
   * exists in the region the project runs in.
   */
  readonly dockerHubSecretName?: string;
}

/**
 * Base-image pulls are the one part of a customer build that leaves AWS.
 * CodeBuild here has no VPC config, so it egresses from a shared AWS address
 * pool, and Docker Hub meters ANONYMOUS pulls per source address — the quota
 * is shared with every other account pulling through the same address. The
 * observed result was HTTP 429 on `FROM` for repositories that were
 * otherwise fine, at times unrelated to this account's own pull volume.
 *
 * Authenticating moves the build onto this account's own metered quota.
 * The retry below stays as the second line: a 429 is a time window, not a
 * verdict on the repository, so the build waits it out instead of reporting
 * the repository as unbuildable.
 */
const DOCKER_HUB_RATE_LIMIT_PATTERN = 'toomanyrequests|429 Too Many Requests|pull rate limit|manifests[^ ]*: 429';

/**
 * Backoff between image-build attempts: 1, 3 and 8 minutes (4 attempts in
 * all). Long enough for a rate-limit window to pass, and bounded well inside
 * the build timeout.
 */
const IMAGE_BUILD_RETRY_DELAYS_SECONDS = [60, 180, 480] as const;

/**
 * Where the retry loop records what happened. The loop itself always exits
 * 0 and two small commands after it decide the build's fate, because
 * CodeBuild reports the FAILING COMMAND'S OWN TEXT as the phase context —
 * and that text is what the control plane classifies the failure from. A
 * loop that failed in place would put its own rate-limit search pattern into
 * the phase context and make every ordinary Dockerfile error read as a rate
 * limit.
 */
const BUILD_OUTCOME_FILE = '/tmp/deployz-build-outcome';

/**
 * Build pipeline construct: ECR repository + CodeBuild project.
 *
 * The CodeBuild project builds Docker images from source in S3 and pushes them
 * to the private ECR repository with an immutable `sha256:` digest.
 *
 * Outputs are exported as stack outputs:
 * - `<stackName>-EcrRepositoryUri` — ECR repository URI (no tag)
 * - `<stackName>-CodeBuildProjectArn` — CodeBuild project ARN
 */
export class BuildPipeline extends Construct {
  public readonly repository: IRepository;
  public readonly project: Project;

  constructor(scope: Construct, id: string, props: BuildPipelineProps) {
    super(scope, id);

    const repoName = props.repositoryName ?? 'deployz-images';

    this.repository = new Repository(this, 'Repository', {
      repositoryName: repoName,
      imageTagMutability: TagMutability.IMMUTABLE,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
    });

    // The ECR repository URI is baked into the buildspec as an environment
    // variable so the build commands can reference it without constructing
    // it from AWS account/region parts.
    const ecrUri = this.repository.repositoryUri;

    // The values themselves are resolved by CodeBuild at build start and are
    // masked in the build log; only the secret NAME and JSON key reach the
    // CloudFormation template.
    const dockerHubSecretName = props.dockerHubSecretName;
    const dockerHubEnvironment: Record<string, BuildEnvironmentVariable> =
      dockerHubSecretName === undefined
        ? {}
        : {
            DOCKERHUB_USERNAME: {
              value: `${dockerHubSecretName}:username`,
              type: BuildEnvironmentVariableType.SECRETS_MANAGER,
            },
            DOCKERHUB_ACCESS_TOKEN: {
              value: `${dockerHubSecretName}:accessToken`,
              type: BuildEnvironmentVariableType.SECRETS_MANAGER,
            },
          };

    // Docker Hub first, ECR second: the base images a customer's Dockerfile
    // pulls come from Docker Hub during `docker build`, the push target is
    // ECR. Both logins are in place before the build phase runs.
    const dockerHubLoginCommands =
      dockerHubSecretName === undefined
        ? []
        : [
            'echo "Logging in to Docker Hub..."',
            // The variables are never echoed — the token reaches `docker
            // login` on stdin, and the command text CodeBuild prints holds
            // the variable names, not their values.
            'if [ -z "$DOCKERHUB_USERNAME" ] || [ -z "$DOCKERHUB_ACCESS_TOKEN" ]; then echo "ERROR: Docker Hub credentials are not available to this build" >&2; exit 1; fi',
            'echo "$DOCKERHUB_ACCESS_TOKEN" | docker login --username "$DOCKERHUB_USERNAME" --password-stdin docker.io',
          ];

    this.project = new Project(this, 'BuildProject', {
      environment: {
        buildImage: LinuxBuildImage.STANDARD_7_0,
        computeType: props.computeType ?? ComputeType.SMALL,
        privileged: true, // Required for Docker-in-Docker builds
        environmentVariables: {
          ECR_REPOSITORY_URI: { value: ecrUri },
          ...dockerHubEnvironment,
        } as Record<string, BuildEnvironmentVariable>,
      },
      timeout: Duration.minutes(props.timeoutMinutes ?? 30),
      buildSpec: BuildSpec.fromObject({
        version: '0.2',
        // Exported so the build's CodeBuild state-change event carries the
        // digest to the worker, which writes it to releases.image_digest.
        // Reading it out of the build log would be guesswork.
        env: { 'exported-variables': ['IMAGE_DIGEST', 'RELEASE_ID'] },
        phases: {
          pre_build: {
            commands: [
              // The project is NO_SOURCE: the control plane put the
              // repository tarball in S3 (SOURCE_S3_URI, passed via
              // startBuild) because the source comes from a GitHub App
              // installation token, which CodeBuild cannot hold.
              'echo "Fetching source from $SOURCE_S3_URI"',
              'if [ -z "$SOURCE_S3_URI" ]; then echo "ERROR: SOURCE_S3_URI is not set" >&2; exit 1; fi',
              'aws s3 cp "$SOURCE_S3_URI" /tmp/source.tar.gz',
              // GitHub tarballs wrap everything in one `owner-repo-sha`
              // directory; --strip-components=1 unwraps it.
              'mkdir -p /tmp/src && tar xzf /tmp/source.tar.gz -C /tmp/src --strip-components=1',
              'cd /tmp/src',
              ...dockerHubLoginCommands,
              'echo "Logging in to Amazon ECR..."',
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI',
              // §21: image tags must be immutable identifiers — `latest` is
              // the anti-pattern §21 explicitly calls out, and the ECR
              // repository above is IMAGE_TAG_MUTABILITY=IMMUTABLE, so a
              // repeated `latest` push would be hard-rejected by ECR on the
              // second build anyway. Use RELEASE_VERSION (passed via
              // startBuild environmentVariablesOverride) when the control
              // plane supplies one; otherwise fall back to CODEBUILD_BUILD_ID
              // (always set by CodeBuild itself, e.g.
              // "project-name:build-uuid") which is guaranteed unique per
              // build, sanitized for use as a Docker tag.
              'export CODEBUILD_TAG=$(echo "$CODEBUILD_BUILD_ID" | tr ":" "-")',
              'export IMAGE_TAG=${RELEASE_VERSION:-$CODEBUILD_TAG}',
              // Fail fast rather than silently falling back to a mutable tag
              // if neither source produced a usable value.
              'if [ -z "$IMAGE_TAG" ]; then echo "ERROR: no usable image tag - RELEASE_VERSION and CODEBUILD_BUILD_ID are both unset" >&2; exit 1; fi',
            ],
          },
          build: {
            commands: [
              'cd /tmp/src',
              // Analysis records where the Dockerfile actually is; a
              // repository is free to keep it out of the root.
              'export DOCKERFILE_PATH=${DOCKERFILE_PATH:-Dockerfile}',
              // The build context is the Dockerfile's own directory, not the
              // repo root. A Dockerfile kept in a subdirectory (e.g.
              // `backend/Dockerfile`) is written relative to that directory —
              // `COPY requirements.txt .` means `backend/requirements.txt` —
              // exactly as `docker build backend/` would resolve it. Passing a
              // bare `.` (repo root) made every such COPY miss and failed the
              // build. dirname of a root Dockerfile is `.`, so root apps are
              // unaffected. An explicit BUILD_CONTEXT passed via startBuild
              // wins over the fallback: the `docker/` convention (e.g.
              // `docker build -f docker/Dockerfile .`) builds from the repo
              // root, not from `docker/`.
              'export BUILD_CONTEXT=${BUILD_CONTEXT:-$(dirname "$DOCKERFILE_PATH")}',
              // Vendor-configured build-stage variables (worker.ts's
              // loadBuildVariables) ride as their own PLAINTEXT CodeBuild
              // environment variables, named by DEPLOYZ_BUILD_ARG_NAMES —
              // never inlined as values here, so a value never reaches the
              // build log or this buildspec. docker build reads each one
              // straight out of the process environment via --build-arg NAME.
              'export DOCKER_BUILD_ARGS=""',
              'for build_arg_name in $DEPLOYZ_BUILD_ARG_NAMES; do DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --build-arg $build_arg_name"; done',
              // The application stage of a Dockerfile that ends with a tooling
              // stage (worker.ts BUILD_TARGET); unset builds the last stage.
              'if [ -n "$BUILD_TARGET" ]; then DOCKER_BUILD_ARGS="$DOCKER_BUILD_ARGS --target $BUILD_TARGET"; fi',
              'echo "Building Docker image: $ECR_REPOSITORY_URI:$IMAGE_TAG from $DOCKERFILE_PATH (context: $BUILD_CONTEXT)"',
              // Retries ONLY a registry rate limit. Success is read from the
              // image itself rather than an exit status, because the build
              // output is piped through `tee` to keep it streaming live.
              // Any other failure breaks out on the first attempt, so a
              // Dockerfile that cannot build still fails in one pass.
              // Joined into ONE line: a buildspec command is a single unit
              // whose exit status CodeBuild checks, and a loop spread over
              // several lines depends on how it splits the script it builds.
              // The trailing `true` is what keeps this command from ever
              // failing in place — see BUILD_OUTCOME_FILE.
              [
                `rm -f ${BUILD_OUTCOME_FILE}`,
                `for retry_delay in ${IMAGE_BUILD_RETRY_DELAYS_SECONDS.join(' ')} last; do docker build -f "$DOCKERFILE_PATH" $DOCKER_BUILD_ARGS -t $ECR_REPOSITORY_URI:$IMAGE_TAG "$BUILD_CONTEXT" 2>&1 | tee /tmp/docker-build.log`,
                `if docker image inspect $ECR_REPOSITORY_URI:$IMAGE_TAG > /dev/null 2>&1; then echo ok > ${BUILD_OUTCOME_FILE}; break; fi`,
                `if ! grep -Eqi '${DOCKER_HUB_RATE_LIMIT_PATTERN}' /tmp/docker-build.log; then echo failed > ${BUILD_OUTCOME_FILE}; break; fi`,
                `echo rate_limited > ${BUILD_OUTCOME_FILE}`,
                'if [ "$retry_delay" = last ]; then break; fi',
                'echo "The container registry temporarily limited image downloads. Retrying in ${retry_delay}s."',
                'sleep "$retry_delay"; done',
                'true',
              ].join('; '),
              // Two separate commands so the phase context CodeBuild reports
              // — the failing command's own text — names the right cause.
              `if [ "$(cat ${BUILD_OUTCOME_FILE} 2>/dev/null)" = rate_limited ]; then echo "Docker Hub rate limit (HTTP 429) blocked the base image download" >&2; exit 1; fi`,
              `if [ "$(cat ${BUILD_OUTCOME_FILE} 2>/dev/null)" != ok ]; then echo "The image build did not produce an image" >&2; exit 1; fi`,
              // Tag with the git SHA for traceability. GIT_SHA is passed via
              // startBuild environmentVariablesOverride.
              'echo "Tagging with GIT_SHA: ${GIT_SHA:-unknown}"',
              'docker tag $ECR_REPOSITORY_URI:$IMAGE_TAG $ECR_REPOSITORY_URI:${GIT_SHA:-unknown}',
            ],
            // Docker Hub is not needed once the image is built. `finally`
            // runs whether the phase passed or failed, and `|| true` keeps a
            // failed logout from replacing the build's real result. The ECR
            // credential is a separate registry entry and is untouched.
            ...(dockerHubSecretName === undefined
              ? {}
              : { finally: ['docker logout docker.io > /dev/null 2>&1 || true'] }),
          },
          post_build: {
            commands: [
              'echo "Pushing Docker image to ECR..."',
              'docker push $ECR_REPOSITORY_URI:$IMAGE_TAG',
              // The repository's tags are IMMUTABLE, and the SHA tag already
              // exists whenever the same commit is released again (a real
              // re-release of v0.1.0's commit as v0.1.1 failed on exactly
              // this). The SHA tag is traceability, not the release identity
              // — the version tag above and the digest below are — so a
              // push refused for an existing tag must not fail the build.
              'docker push $ECR_REPOSITORY_URI:${GIT_SHA:-unknown} || echo "SHA tag already exists (immutable repository) — keeping the existing tag"',
              // Extract the immutable sha256 digest. The format string uses
              // double-brace escaping: `{{...}}` is the Go template syntax
              // for docker inspect; CodeBuild does NOT interpret `{{ }}`.
              // The shell receives the literal `{{index .RepoDigests 0}}`.
              'echo "Recording image digest..."',
              'export IMAGE_DIGEST=$(docker inspect --format="{{index .RepoDigests 0}}" $ECR_REPOSITORY_URI:$IMAGE_TAG)',
              'echo "IMAGE_DIGEST=$IMAGE_DIGEST"',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permission to push images to the ECR repository and
    // to read the source tarball the control plane uploaded.
    this.repository.grantPullPush(this.project);
    props.sourceBucket.grantRead(this.project);

    // Read the Docker Hub credential and nothing else: one action, one
    // secret. The six-character suffix Secrets Manager appends to every
    // secret ARN is unknown at synth time, so the resource ends in the
    // wildcard AWS itself documents for name-addressed secrets.
    if (dockerHubSecretName !== undefined) {
      this.project.addToRolePolicy(
        new PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [
            Stack.of(this).formatArn({
              service: 'secretsmanager',
              resource: 'secret',
              resourceName: `${dockerHubSecretName}-??????`,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      );
    }

    // ── Stack outputs ──────────────────────────────────────────────────
    const stack = Stack.of(this);
    stack.exportValue(this.repository.repositoryUri, {
      name: `${stack.stackName}-EcrRepositoryUri`,
    });
    stack.exportValue(this.project.projectName, {
      name: `${stack.stackName}-CodeBuildProjectName`,
    });
  }
}