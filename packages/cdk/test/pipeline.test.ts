import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket, type IBucket } from 'aws-cdk-lib/aws-s3';

import { BuildPipeline } from '../src/pipeline/build-pipeline.js';
import {
  fetchRepoArchive,
  MAX_SOURCE_TARBALL_BYTES,
  needsStreaming,
  STREAMING_THRESHOLD_BYTES,
  type FetchFn,
  type FetchRepoArchiveOptions,
} from '../src/pipeline/source-fetch.js';
import type { S3Client } from '../src/quick-create/publish.js';

// ── CDK Pipeline Tests ───────────────────────────────────────────────────

describe('BuildPipeline', () => {
  function synth() {
    const app = new App();
    const stack = new Stack(app, 'PipelineTest', {
      env: { region: 'us-east-1' },
    });
    // CodeBuild reads the repository tarball the control plane uploaded; the
    // source comes from a GitHub App installation token, which CodeBuild
    // cannot hold, so the project has no source of its own.
    const sourceBucket = new Bucket(stack, 'SourceBucket') as IBucket;
    const pipeline = new BuildPipeline(stack, 'BuildPipeline', { sourceBucket });
    const template = Template.fromStack(stack);
    return { app, stack, pipeline, template };
  }

  it('synthesizes without errors', () => {
    const { template } = synth();
    expect(template).toBeDefined();
  });

  it('creates an ECR repository with immutable tags', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  it('creates a CodeBuild project', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CodeBuild::Project', 1);
  });

  it('limits how many builds run at once', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', { ConcurrentBuildLimit: 5 });
  });

  it('CodeBuild project uses privileged mode for Docker builds', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        PrivilegedMode: true,
        ComputeType: 'BUILD_GENERAL1_SMALL',
      },
    });
  });

  it('CodeBuild project has ECR_REPOSITORY_URI environment variable', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        EnvironmentVariables: [
          {
            Name: 'ECR_REPOSITORY_URI',
            Type: 'PLAINTEXT',
            Value: { 'Fn::Join': ['', Match.anyValue()] },
          },
        ],
      },
    });
  });

  it('buildspec includes ECR login, docker build, and digest recording phases', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: {
        Type: 'NO_SOURCE',
      },
      TimeoutInMinutes: 30,
    });
    // The buildspec is embedded as a JSON string — verify key phase commands
    // are present by checking the serialized Source property shape.
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // Key build phase should contain docker build
    expect(sourceJson).toContain('docker build');
    // Post-build phase should record the image digest, exported so the
    // build's state-change event carries it back to the control plane.
    expect(sourceJson).toContain('IMAGE_DIGEST');
    expect(sourceJson).toContain('exported-variables');
  });

  it('turns DEPLOYZ_BUILD_ARG_NAMES into --build-arg flags on the docker build command, never a value', () => {
    const { template } = synth();
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    expect(sourceJson).toContain('DEPLOYZ_BUILD_ARG_NAMES');
    expect(sourceJson).toContain('--build-arg');
    // The names ride as their own CodeBuild env var, not baked into the
    // buildspec text — docker reads each value out of the environment.
    expect(sourceJson).toContain('DOCKER_BUILD_ARGS');
  });

  it('builds with the Dockerfile directory as context, not always the repo root', () => {
    // A Dockerfile that lives in a subdirectory (e.g. `backend/Dockerfile`) is
    // conventionally written to be built with that subdirectory as its
    // context — `COPY requirements.txt .` resolves against `backend/`, not the
    // repo root. Building with a hardcoded `.` context breaks every such app.
    // The buildspec must derive the context from DOCKERFILE_PATH's directory.
    const { template } = synth();
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // Context is derived from the Dockerfile's directory, but an explicit
    // BUILD_CONTEXT passed by startBuild (e.g. for `docker/`-convention
    // repos) overrides the dirname fallback.
    expect(sourceJson).toContain('BUILD_CONTEXT=\\\\\\"${BUILD_CONTEXT:-$(dirname');
    // The build passes that context to docker, never a bare `.`.
    expect(sourceJson).toContain('-t \\\\\\"$ECR_REPOSITORY_URI:$IMAGE_TAG\\\\\\"');
    expect(sourceJson).toContain('$BUILD_CONTEXT');
    expect(sourceJson).not.toContain('$ECR_REPOSITORY_URI:$IMAGE_TAG .');
    // No bare git-SHA tag: the release tag and the digest are the identity.
    expect(sourceJson).not.toContain('GIT_SHA');
    // A detected application stage rides as BUILD_TARGET; unset builds the last stage.
    expect(sourceJson).toContain('--target $BUILD_TARGET');
  });

  it('never falls back to the mutable `latest` tag (§21)', () => {
    const { template } = synth();
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const sourceJson = JSON.stringify(project!.Properties!['Source']);
    // No `:latest` fallback anywhere in the buildspec.
    expect(sourceJson).not.toContain(':-latest');
    expect(sourceJson).not.toContain('IMAGE_TAG=latest');
    // The tag falls back to a per-build-unique CodeBuild id, not a shared name.
    expect(sourceJson).toContain('CODEBUILD_BUILD_ID');
    // The build fails fast rather than silently using a mutable tag.
    expect(sourceJson).toContain('no usable image tag');
  });

  it('produces CloudFormation outputs for ECR URI and CodeBuild project name', () => {
    const { template } = synth();
    const json = template.toJSON() as { Outputs?: Record<string, unknown> };
    const outputs = Object.keys(json.Outputs ?? {});
    expect(outputs.some((o) => o.includes('EcrRepositoryUri'))).toBe(true);
    expect(outputs.some((o) => o.includes('CodeBuildProjectName'))).toBe(true);
  });

  it('ECR repository URI is non-empty', () => {
    const { pipeline } = synth();
    expect(pipeline.repository.repositoryUri).toBeTruthy();
  });

  it('CodeBuild project has a name', () => {
    const { pipeline } = synth();
    expect(pipeline.project.projectName).toBeTruthy();
  });

  it('accepts custom repository name', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomRepo', {
      env: { region: 'us-east-1' },
    });
    new BuildPipeline(stack, 'CustomPipeline', {
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
      repositoryName: 'my-custom-images',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'my-custom-images',
    });
  });

  it('accepts custom compute type', async () => {
    const app = new App();
    const stack = new Stack(app, 'CustomCompute', {
      env: { region: 'us-east-1' },
    });
    const { ComputeType } = await import('aws-cdk-lib/aws-codebuild');
    new BuildPipeline(stack, 'CustomPipeline', {
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
      computeType: ComputeType.MEDIUM,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        ComputeType: 'BUILD_GENERAL1_MEDIUM',
      },
    });
  });

  // ── Docker Hub authentication ──────────────────────────────────────────
  //
  // Base images are pulled from Docker Hub during `docker build`. Without a
  // login those pulls are anonymous and metered per source address — an
  // address CodeBuild shares with other accounts, because the project has no
  // VPC config. The observed result was HTTP 429 against repositories that
  // build perfectly well at another hour.

  const DOCKER_HUB_SECRET = 'deployz-codebuild';

  function synthWithDockerHub() {
    const app = new App();
    const stack = new Stack(app, 'DockerHubPipeline', { env: { region: 'us-east-1' } });
    new BuildPipeline(stack, 'BuildPipeline', {
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
      dockerHubSecretName: DOCKER_HUB_SECRET,
    });
    return Template.fromStack(stack);
  }

  /**
   * The buildspec's commands as plain shell text, one per line, each tagged
   * with the phase and list it came from. Matching the serialized template
   * instead would mean writing every assertion through two layers of JSON
   * escaping.
   */
  function buildSpecOf(template: Template): string {
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    expect(project).toBeDefined();
    const spec = JSON.parse((project!.Properties!['Source'] as { BuildSpec: string }).BuildSpec) as {
      phases: Record<string, { commands?: string[]; finally?: string[] }>;
    };
    return Object.entries(spec.phases)
      .flatMap(([phase, body]) => [
        ...(body.commands ?? []).map((command) => `${phase}:commands ${command}`),
        ...(body.finally ?? []).map((command) => `${phase}:finally ${command}`),
      ])
      .join('\n');
  }

  it('injects the Docker Hub credential as Secrets Manager environment variables', () => {
    const template = synthWithDockerHub();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: {
        EnvironmentVariables: Match.arrayWith([
          {
            Name: 'DOCKERHUB_USERNAME',
            Type: 'SECRETS_MANAGER',
            Value: `${DOCKER_HUB_SECRET}:username`,
          },
          {
            Name: 'DOCKERHUB_ACCESS_TOKEN',
            Type: 'SECRETS_MANAGER',
            Value: `${DOCKER_HUB_SECRET}:accessToken`,
          },
        ]),
      },
    });
  });

  it('keeps the credential out of the synthesized template', () => {
    // Only the secret NAME and its JSON keys may appear. A PLAINTEXT
    // variable, or a resolved value, would put the token in CloudFormation.
    const template = synthWithDockerHub();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain(`${DOCKER_HUB_SECRET}:accessToken`);
    expect(json).not.toContain('dckr_pat');
    expect(json).not.toMatch(/"Name":\s*"DOCKERHUB_ACCESS_TOKEN",\s*"Type":\s*"PLAINTEXT"/);
    const resources = (template.toJSON() as { Resources: Record<string, { Properties?: Record<string, unknown> }> })
      .Resources;
    const project = Object.values(resources).find(
      (r) => r.Properties?.['Source']?.['Type'] === 'NO_SOURCE',
    );
    const variables = (
      project!.Properties!['Environment'] as { EnvironmentVariables: { Name: string; Type?: string }[] }
    ).EnvironmentVariables;
    for (const variable of variables) {
      if (!variable.Name.startsWith('DOCKERHUB_')) continue;
      expect(variable.Type).toBe('SECRETS_MANAGER');
    }
  });

  it('grants the build role GetSecretValue on that one secret and nothing more', () => {
    const template = synthWithDockerHub();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:GetSecretValue',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': ['', Match.arrayWith([`:secret:${DOCKER_HUB_SECRET}-??????`])],
            },
          }),
        ]),
      },
    });
    // No blanket secret access, and no write or rotation actions.
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('secretsmanager:*');
    expect(json).not.toContain('secretsmanager:PutSecretValue');
    expect(json).not.toContain('secretsmanager:UpdateSecret');
    expect(json).not.toContain('secretsmanager:DescribeSecret');
  });

  it('authenticates to Docker Hub before ECR and before the image build', () => {
    const spec = buildSpecOf(synthWithDockerHub());
    const dockerHubLogin = spec.indexOf('--password-stdin docker.io');
    const ecrLogin = spec.indexOf('get-login-password');
    const imageBuild = spec.indexOf('docker build');
    expect(dockerHubLogin).toBeGreaterThan(-1);
    expect(dockerHubLogin).toBeLessThan(ecrLogin);
    expect(ecrLogin).toBeLessThan(imageBuild);
  });

  it('passes the token on stdin and never echoes a credential', () => {
    const spec = buildSpecOf(synthWithDockerHub());
    expect(spec).toContain('--password-stdin');
    // `docker login --password <token>` would put the token in the process
    // list and in the command text CodeBuild prints.
    expect(spec).not.toContain('--password "$DOCKERHUB_ACCESS_TOKEN"');
    expect(spec).not.toContain('set -x');
    // The only `echo` of the token pipes it into stdin; nothing prints it.
    expect(spec).not.toContain('echo "Docker Hub token: ');
    expect(spec).not.toContain('echo $DOCKERHUB_ACCESS_TOKEN');
  });

  it('fails the build early when a credential is missing', () => {
    const spec = buildSpecOf(synthWithDockerHub());
    expect(spec).toContain('if [ -z "$DOCKERHUB_USERNAME" ] || [ -z "$DOCKERHUB_ACCESS_TOKEN" ]');
    expect(spec).toContain('Docker Hub credentials are not available to this build');
  });

  it('logs out of Docker Hub in a finally block that cannot mask the result', () => {
    const spec = buildSpecOf(synthWithDockerHub());
    expect(spec).toContain('build:finally docker logout docker.io > /dev/null 2>&1 || true');
    // A logout that ran as an ordinary command would replace the build's own
    // failure with its own, and would not run at all when the build failed.
    expect(spec).not.toContain('build:commands docker logout');
  });

  it('leaves the pipeline unchanged when no Docker Hub secret is configured', () => {
    // The wiring must be inert until the secret exists in this region:
    // CodeBuild resolves a SECRETS_MANAGER variable at build START, so a
    // name that does not resolve would fail every build.
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('DOCKERHUB_USERNAME');
    expect(json).not.toContain('DOCKERHUB_ACCESS_TOKEN');
    expect(json).not.toContain('secretsmanager:GetSecretValue');
    expect(buildSpecOf(template)).not.toContain('docker.io');
  });

  it('retries a rate-limited image build at 1, 3 and 8 minutes', () => {
    const spec = buildSpecOf(synth().template);
    expect(spec).toContain('for retry_delay in 60 180 480 last');
    expect(spec).toContain('sleep "$retry_delay"');
  });

  it('retries only a registry rate limit, never an ordinary build error', () => {
    const spec = buildSpecOf(synth().template);
    // The loop breaks out on the first attempt unless the log carries a
    // rate-limit signature, so a broken Dockerfile still fails in one pass.
    expect(spec).toContain('toomanyrequests|429 Too Many Requests|pull rate limit');
    expect(spec).toContain('echo failed > /tmp/deployz-build-outcome; break; fi');
  });

  it('reports a rate limit and an ordinary failure as different commands', () => {
    // CodeBuild reports the FAILING COMMAND'S text as the phase context, and
    // the control plane classifies from that text. One command that failed
    // for both causes would carry its own rate-limit search pattern into
    // every ordinary build failure.
    const spec = buildSpecOf(synth().template);
    expect(spec).toContain('Docker Hub rate limit (HTTP 429) blocked the base image download');
    expect(spec).toContain('The image build did not produce an image');
    const retryLoop = spec.indexOf('for retry_delay in');
    const rateLimitExit = spec.indexOf('Docker Hub rate limit (HTTP 429)');
    expect(retryLoop).toBeLessThan(rateLimitExit);
  });

  it('accepts custom timeout', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomTimeout', {
      env: { region: 'us-east-1' },
    });
    new BuildPipeline(stack, 'CustomPipeline', {
      sourceBucket: new Bucket(stack, 'SourceBucket') as IBucket,
      timeoutMinutes: 60,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      TimeoutInMinutes: 60,
    });
  });
});

// ── Source Fetch Tests ────────────────────────────────────────────────────

function createMockFetch(
  tarballBytes: Uint8Array = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), // minimal gzip
  status = 200,
  redirectUrl?: string,
): FetchFn {
  const self = {
    async fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string> },
    ): Promise<{
      status: number;
      headers: { get(name: string): string | null };
      arrayBuffer(): Promise<ArrayBuffer>;
      text(): Promise<string>;
    }> {
      // If a redirect URL is configured and this is the API call, return a redirect
      if (redirectUrl && url.includes('api.github.com')) {
        return {
          status: 302,
          headers: {
            get(name: string): string | null {
              return name === 'location' ? redirectUrl : null;
            },
          },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          text: () => Promise.resolve(''),
        };
      }
      return {
        status,
        headers: {
          get(_name: string): string | null {
            return null;
          },
        },
        arrayBuffer: () => Promise.resolve(tarballBytes.buffer),
        text: () => Promise.resolve(''),
      };
    },
  };
  return self.fetch.bind(self);
}

function createMockS3(): S3Client & { _uploads: Array<{ key: string; bytes: number }> } {
  const uploads: Array<{ key: string; bytes: number }> = [];
  return {
    _uploads: uploads,
    async putObject(params: {
      bucket: string;
      key: string;
      body: Uint8Array | string;
      contentType?: string;
    }): Promise<void> {
      const bytes =
        typeof params.body === 'string'
          ? new TextEncoder().encode(params.body).length
          : params.body.length;
      uploads.push({ key: params.key, bytes });
    },
  };
}

const FAKE_TOKEN = 'ghs_test-token';
const REPO_NAME = 'test-org/test-repo';

function makeOptions(overrides?: Partial<FetchRepoArchiveOptions>): FetchRepoArchiveOptions {
  return {
    bucket: 'test-bucket',
    s3KeyPrefix: 'build-source/test-org/test-repo',
    ref: 'main',
    ...overrides,
  };
}

describe('source-fetch', () => {
  describe('fetchRepoArchive', () => {
    it('fetches a repo tarball and uploads it to S3', async () => {
      const tarball = new Uint8Array(1024).fill(0xab);
      const mockFetch = createMockFetch(tarball);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions(),
      );

      expect(result.s3Key).toBe('build-source/test-org/test-repo/main.tar.gz');
      expect(result.bytes).toBe(1024);
      expect(result.ref).toBe('main');
      expect(mockS3._uploads).toHaveLength(1);
      expect(mockS3._uploads[0].key).toBe('build-source/test-org/test-repo/main.tar.gz');
      expect(mockS3._uploads[0].bytes).toBe(1024);
    });

    it('follows a 302 redirect from the GitHub API', async () => {
      const tarball = new Uint8Array(512);
      const redirectUrl = 'https://codeload.github.com/test-org/test-repo/legacy.tar.gz/main';
      const mockFetch = createMockFetch(tarball, 200, redirectUrl);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions(),
      );

      expect(result.bytes).toBe(512);
      expect(mockS3._uploads).toHaveLength(1);
    });

    it('throws when the GitHub API returns a non-2xx status', async () => {
      const mockFetch = createMockFetch(new Uint8Array(0), 404);
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/Failed to fetch repo tarball/);
    });

    it('refuses a tarball whose declared length is over the cap', async () => {
      const mockFetch: FetchFn = async () => ({
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? String(MAX_SOURCE_TARBALL_BYTES + 1) : null) },
        arrayBuffer: () => Promise.reject(new Error('must not read the body')),
        text: () => Promise.resolve(''),
      });
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/is larger than/);
      expect(mockS3._uploads).toHaveLength(0);
    });

    it('stops reading a streamed tarball that grows past the cap', async () => {
      let cancelled = false;
      const chunk = new Uint8Array(64 * 1024 * 1024);
      const mockFetch: FetchFn = async () => ({
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.reject(new Error('must not buffer the body')),
        text: () => Promise.resolve(''),
        body: {
          getReader: () => ({
            read: () => Promise.resolve({ done: false, value: chunk }),
            cancel: () => {
              cancelled = true;
              return Promise.resolve();
            },
          }),
        },
      });
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/is larger than/);
      expect(cancelled).toBe(true);
      expect(mockS3._uploads).toHaveLength(0);
    });

    it('throws when the redirect has no Location header', async () => {
      // Pass a redirect status but no redirectUrl — so the API returns 302 without a Location header
      const mockFetch: FetchFn = async (url) => {
        if (url.includes('api.github.com')) {
          return {
            status: 302,
            headers: { get: () => null },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            text: () => Promise.resolve(''),
          };
        }
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new Uint8Array(0).buffer),
          text: () => Promise.resolve(''),
        };
      };
      const mockS3 = createMockS3();

      await expect(
        fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions()),
      ).rejects.toThrow(/without a Location header/);
    });

    it('uses a custom ref when provided', async () => {
      const tarball = new Uint8Array(256);
      const mockFetch = createMockFetch(tarball);
      const mockS3 = createMockS3();

      const result = await fetchRepoArchive(
        FAKE_TOKEN,
        REPO_NAME,
        mockFetch,
        mockS3,
        makeOptions({ ref: 'v2.0.0' }),
      );

      expect(result.ref).toBe('v2.0.0');
      expect(result.s3Key).toBe('build-source/test-org/test-repo/v2.0.0.tar.gz');
    });

    it('uploads with the correct content type', async () => {
      const tarball = new Uint8Array(64);
      const mockFetch = createMockFetch(tarball);
      let capturedContentType: string | undefined;
      const mockS3: S3Client & {
        _uploads: Array<{ key: string; contentType?: string }>;
      } = {
        _uploads: [],
        async putObject(params) {
          this._uploads.push({
            key: params.key,
            contentType: params.contentType,
          });
        },
      };

      await fetchRepoArchive(FAKE_TOKEN, REPO_NAME, mockFetch, mockS3, makeOptions());

      expect(mockS3._uploads[0].contentType).toBe('application/gzip');
    });
  });

  describe('needsStreaming', () => {
    it('returns true when content length exceeds the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES + 1)).toBe(true);
    });

    it('returns false when content length is below the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES - 1)).toBe(false);
    });

    it('returns true when content length is unknown (null)', () => {
      expect(needsStreaming(null)).toBe(true);
    });

    it('returns false when content length exactly equals the threshold', () => {
      expect(needsStreaming(STREAMING_THRESHOLD_BYTES)).toBe(false);
    });
  });
});