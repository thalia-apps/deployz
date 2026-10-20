import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { detectLocalFilesystem } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import {
  checkDockerComposeMultiService,
  checkKubernetes,
  checkPersistentVolumes,
  checkPulumi,
  checkRedisUnsupported,
  checkTerraform,
} from '../src/rejection.js';

// Phase 2 of MVP compatibility hardening: the gate must stop rejecting apps
// that fit (dev Compose files, same-image workers, sample charts, volumes that
// an S3 option replaces) and must keep rejecting apps that do not. The
// "stays rejected" fixtures come first; each reproduces the shape of a real
// application that needs a second image or durable local disk.

const APP = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';
const compose = (...lines: string[]): string => [...lines, ''].join('\n');
const multiService = (tree: FileTree): boolean => checkDockerComposeMultiService(tree).detected;

describe('stays rejected — a second required service or image', () => {
  it('a backend and a separate frontend image behind a proxy', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  backend:',
          '    image: ghcr.io/acme/app/backend:develop',
          '  frontend:',
          '    image: ghcr.io/acme/app/frontend:develop',
          '  db:',
          '    image: postgres:15',
          '  proxy:',
          '    image: caddy:latest',
        ),
      }),
    ).toBe(true);
  });

  it('a web image next to its own streaming image, with a worker on the web image', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  web:',
          '    image: ghcr.io/acme/app:v4',
          '    command: bundle exec puma',
          '  streaming:',
          '    image: ghcr.io/acme/app-streaming:v4',
          '    command: node ./streaming/index.js',
          '  sidekiq:',
          '    image: ghcr.io/acme/app:v4',
          '    command: bundle exec sidekiq',
        ),
      }),
    ).toBe(true);
  });

  it('two applications built from one Dockerfile with different build args', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  builder:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile',
          '      args:',
          '        SCOPE: builder',
          '  viewer:',
          '    build:',
          '      context: .',
          '      dockerfile: Dockerfile',
          '      args:',
          '        SCOPE: viewer',
        ),
      }),
    ).toBe(true);
  });

  it('two applications published as different images', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  builder:',
          '    image: acme/app-builder:latest',
          '  viewer:',
          '    image: acme/app-viewer:latest',
        ),
      }),
    ).toBe(true);
  });

  it('an app and a hub service it reaches by name, next to one-shot jobs and infrastructure', () => {
    expect(
      multiService({
        'docker/docker-compose.yml': compose(
          'services:',
          '  postgres:',
          '    image: pgvector/pgvector:pg18',
          '  app-migrate:',
          '    image: ghcr.io/acme/app:latest',
          '  app:',
          '    image: ghcr.io/acme/app:latest',
          '    environment:',
          '      HUB_API_URL: http://hub:8080',
          '    depends_on:',
          '      app-migrate:',
          '        condition: service_completed_successfully',
          '  hub:',
          '    image: ghcr.io/acme/hub:latest',
          '  cube:',
          '    image: cubejs/cube:v1',
        ),
      }),
    ).toBe(true);
  });

  it('an app built from source next to its UI and media images', () => {
    expect(
      multiService({
        'docker/docker-compose.yml': compose(
          'services:',
          '  proxy:',
          '    image: nginx:1-alpine',
          '  app:',
          '    build:',
          '      context: ../',
          '      dockerfile: docker/Dockerfile',
          '  app-ui:',
          '    image: acme/app-ui:nightly',
        ),
      }),
    ).toBe(true);
  });

  it('frontend, backend and exporter images', () => {
    expect(
      multiService({
        'docker/images/docker-compose.yaml': compose(
          'services:',
          '  app-frontend:',
          '    image: "acme/frontend:2"',
          '  app-backend:',
          '    image: "acme/backend:2"',
          '  app-exporter:',
          '    image: "acme/exporter:2"',
        ),
      }),
    ).toBe(true);
  });

  it('several applications that each build from their own Dockerfile', () => {
    expect(
      multiService({
        'docker-compose.yaml': compose(
          'services:',
          '  server:',
          '    build:',
          '      context: .',
          '      dockerfile: apps/server/Dockerfile',
          '  dashboard:',
          '    build:',
          '      context: .',
          '      dockerfile: apps/dashboard/Dockerfile',
        ),
      }),
    ).toBe(true);
  });

  it('a build-only extra that the app depends on', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  app:',
          '    image: acme/app',
          '    build: .',
          '    depends_on:',
          '      - api',
          '  api:',
          '    build:',
          '      context: .',
          '      dockerfile: apps/api/Dockerfile',
        ),
      }),
    ).toBe(true);
  });

  it('a Kubernetes platform keeps its manifests as a rejection', () => {
    const tree: FileTree = {
      'go.mod': 'module example.com/platform\n\nrequire (\n\tk8s.io/client-go v0.30.0\n)\n',
      'manifests/kustomization.yaml': 'kind: Kustomization\n',
      'deploy/install.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: controller\n',
    };
    expect(checkKubernetes(tree).detected).toBe(true);
  });
});

describe('stays rejected — durable local state with no object-storage option', () => {
  it('a data VOLUME in the selected Dockerfile', () => {
    expect(detectLocalFilesystem({ Dockerfile: `${APP}VOLUME /app/data\n` }).detected).toBe(true);
  });

  it('a Compose uploads volume on the app service', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'docker-compose.yml': compose('services:', '  app:', '    build: .', '    volumes:', '      - media:/app/media'),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('a data volume whose app has an S3 SDK but no storage switch', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}VOLUME /data/uploads\n`,
      'requirements.txt': 'boto3==1.34.0\n',
      'app/main.py': 'import boto3\n',
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('git repositories on /data stay local even when attachments can use object storage', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}VOLUME /data\n`,
      'requirements.txt': 'boto3==1.34.0\n',
      'app/storage.py': "STORAGE_TYPE = os.environ.get('STORAGE_TYPE', 'local')\n",
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('an embedded database volume without a selectable PostgreSQL engine', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}ENV DB_URL='/appdata/db/db.sqlite'\nVOLUME /appdata\n`,
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('an app data directory that holds more than the database', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}ENV DB_URL='/appdata/db/db.sqlite'\nENV FILES_DIR='/appdata/files'\nVOLUME /appdata\n`,
      'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0' } }),
      'src/db.ts': "import pg from 'pg';\n",
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('a Compose volume that holds the embedded database and framework storage, with PostgreSQL (2fauth)', () => {
    const entrypoint = [
      'if [ ! -f /2fauth/database.sqlite ]; then touch /2fauth/database.sqlite; fi',
      'ln -s /2fauth/database.sqlite /srv/database/database.sqlite',
      'if [ ! -d /2fauth/storage ]; then mv /srv/storage /2fauth/storage; fi',
      'echo "${COMMIT}" > /2fauth/installed',
    ].join('\n');
    const tree = (extra: string): FileTree => ({
      Dockerfile: `${APP}COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh\nENTRYPOINT ["/usr/local/bin/entrypoint.sh"]\n`,
      'docker/entrypoint.sh': `${entrypoint}\n${extra}`,
      'docker/docker-compose.yml': 'services:\n  2fauth:\n    image: 2fauth/2fauth:latest\n    volumes:\n      - ./2fauth:/2fauth\n',
      'composer.json': JSON.stringify({ require: { 'ext-pdo_pgsql': '*' } }),
      'config/database.php': "'pgsql' => ['driver' => 'pgsql'],\n",
    });
    expect(detectLocalFilesystem(tree('')).detected).toBe(false);
    expect(detectLocalFilesystem(tree('mkdir -p /2fauth/uploads')).detected).toBe(true);
  });

  it('a volume from a non-selected development Dockerfile is not read, but the selected one is', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}VOLUME /app/data\n`,
      'dev/Dockerfile': `${APP}VOLUME /dev/state\n`,
    };
    expect(detectLocalFilesystem(tree)).toMatchObject({ detected: true, value: ['VOLUME /app/data (Dockerfile)'] });
  });
});

describe('stays rejected — infrastructure code that is the app', () => {
  it('root-level Terraform, a root Helm chart and a root Pulumi project', () => {
    expect(checkTerraform({ 'main.tf': 'resource "aws_instance" "x" {}\n' }).detected).toBe(true);
    expect(checkKubernetes({ 'Chart.yaml': 'name: app\n' }).detected).toBe(true);
    expect(checkPulumi({ 'Pulumi.yaml': 'name: demo\nruntime: nodejs\n' }).detected).toBe(true);
  });

  it('Kubernetes manifests outside the deployment-sample directories', () => {
    const tree: FileTree = {
      'kubernetes-manifests/web.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n',
    };
    expect(checkKubernetes(tree).detected).toBe(true);
  });
});

describe('Compose scoping — only the production Compose file counts', () => {
  const flagsmith = compose(
    'services:',
    '  postgres:',
    '    image: postgres:15',
    '  migrate-db:',
    '    image: flagsmith/flagsmith:latest',
    '    command:',
    '      - migrate',
    '  flagsmith:',
    '    image: flagsmith/flagsmith:latest',
    '    command:',
    '      - serve',
    '    depends_on:',
    '      migrate-db:',
    '        condition: service_completed_successfully',
    '  flagsmith-task-processor:',
    '    image: flagsmith/flagsmith:latest',
    '    command: run-task-processor',
    '    depends_on:',
    '      migrate-db:',
    '        condition: service_completed_successfully',
  );

  it('a service on the same image with another command is a worker, not a second app', () => {
    expect(multiService({ 'docker-compose.yml': flagsmith })).toBe(false);
  });

  it('a service on the same build with another command is a worker', () => {
    expect(
      multiService({
        'docker-compose.yml': compose(
          'services:',
          '  web:',
          '    build: .',
          '  threaded:',
          '    build: .',
          '    command: bin/threaded.rb',
        ),
      }),
    ).toBe(false);
  });

  it('an optional build-only API, a database studio and a prisma tag on the app image', () => {
    const calcom = compose(
      'services:',
      '  database:',
      '    image: postgres',
      '  calcom:',
      '    image: acme/cal',
      '    build:',
      '      context: .',
      '      dockerfile: Dockerfile',
      '      args:',
      '        NEXT_PUBLIC_API_V2_URL: ${NEXT_PUBLIC_API_V2_URL}',
      '    depends_on:',
      '      - database',
      '  calcom-api:',
      '    container_name: calcom-api',
      '    build:',
      '      context: .',
      '      dockerfile: apps/api/v2/Dockerfile',
      '    depends_on:',
      '      - database',
      '  studio:',
      '    image: acme/cal',
      '    command:',
      '      - npx',
      '      - prisma',
      '      - studio',
    );
    expect(multiService({ 'docker-compose.yml': calcom })).toBe(false);
  });

  it('prefers the production Compose file over the development one at the root', () => {
    const tree: FileTree = {
      'docker-compose.yaml': compose(
        'services:',
        '  rails:',
        '    build:',
        '      context: .',
        '      dockerfile: docker/dockerfiles/rails.Dockerfile',
        '  vite:',
        '    build:',
        '      context: .',
        '      dockerfile: docker/dockerfiles/vite.Dockerfile',
      ),
      'docker-compose.production.yaml': compose(
        'services:',
        '  rails:',
        '    image: acme/app:latest',
        '    command: bundle exec rails s',
        '  sidekiq:',
        '    image: acme/app:latest',
        '    command: bundle exec sidekiq',
      ),
    };
    expect(multiService(tree)).toBe(false);
  });

  it('a Compose file that only runs development support services has no app services', () => {
    const tree: FileTree = {
      'server/build/docker-compose.yml': compose(
        'services:',
        '  postgres:',
        '    image: postgres:14',
        '  minio:',
        '    image: minio/minio',
        '  inbucket:',
        '    image: inbucket/inbucket',
        '  openldap:',
        '    image: osixia/openldap',
        '  keycloak:',
        '    image: quay.io/keycloak/keycloak',
        '  grafana:',
        '    image: grafana/grafana',
      ),
    };
    expect(multiService(tree)).toBe(false);
  });

  it('a Compose file that mounts the repository checkout is a development stack', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        '  app:',
        '    build:',
        '      context: .',
        '      dockerfile: ./dev/docker/Dockerfile',
        '    volumes:',
        '      - ./:/app',
        '  node:',
        '    image: node:22-alpine',
        '    volumes:',
        '      - ./:/app',
        '  worker:',
        '    image: acme/worker',
        '    volumes:',
        '      - ./:/app',
      ),
    };
    expect(multiService(tree)).toBe(false);
  });

  it('a node helper and a front-end dev server are tools, not application services', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        '  app:',
        '    image: acme/app',
        '  node:',
        '    image: node:22-alpine',
        '  assets:',
        '    image: acme/assets',
        '    command: yarn dev',
      ),
    };
    expect(multiService(tree)).toBe(false);
  });

  it('ignores Compose files in docs, contrib, build and demo directories', () => {
    for (const path of ['docs/install/docker-compose.yml', 'contrib/docker-compose.yml', 'build/docker-compose.yml', 'demo/docker-compose.yml']) {
      const tree: FileTree = {
        [path]: compose('services:', '  a:', '    image: acme/a', '  b:', '    image: acme/b'),
      };
      expect(multiService(tree)).toBe(false);
    }
  });
});

describe('local storage scoping', () => {
  it('ignores a Compose volume in a docs install example', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'docs/install/docker/docker-compose.yml': compose(
        'services:',
        '  web:',
        '    image: acme/recipes',
        '    volumes:',
        '      - ./mediafiles:/opt/recipes/mediafiles',
      ),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('ignores static, build output and source mounts', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'docker-compose.yml': compose(
        'services:',
        '  web:',
        '    build: .',
        '    volumes:',
        '      - staticfiles:/opt/app/staticfiles',
        '      - vendor:/var/www/vendor',
        '      - dist:/app/dist',
      ),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('clears an uploads volume when the app can store uploads in S3', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'requirements.txt': 'boto3==1.34.0\n',
      'app/config.py': "UPLOAD_PROVIDER = os.getenv('UPLOAD_PROVIDER', 'filesystem')\nif UPLOAD_PROVIDER == 's3':\n    pass\n",
      'docker-compose.yml': compose(
        'services:',
        '  app:',
        '    build: .',
        '    volumes:',
        '      - .data/uploads:/var/uploads',
      ),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('clears a Rails storage volume when ActiveStorage can use Amazon S3', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      Gemfile: "gem 'aws-sdk-s3'\n",
      '.env.example': 'ACTIVE_STORAGE_SERVICE=local\n',
      'docker-compose.yml': compose('services:', '  rails:', '    build: .', '    volumes:', '      - storage_data:/app/storage'),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('clears a volume that only holds the embedded SQLite file when PostgreSQL can be selected', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}ENV DB_URL='/appdata/db/db.sqlite'\nENV DB_DIALECT='sqlite'\nVOLUME /appdata\n`,
      'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0' } }),
      'src/db.ts': "import pg from 'pg';\n",
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('ignores a Compose volume that mounts the checkout, in a development stack', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'compose.yaml': compose(
        'services:',
        '  php:',
        '    build: .',
        '    volumes:',
        '      - .:/var/www/html',
        '      - data:/var/www/html/data',
      ),
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });
});

describe('deployment files in sample directories warn and never block', () => {
  const chart: FileTree = {
    Dockerfile: APP,
    'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node server.js' } }),
    'charts/app/Chart.yaml': 'name: app\n',
  };
  const terraform: FileTree = {
    Dockerfile: APP,
    'packages/app-docker/k8s/terraform/main.tf': 'resource "kubernetes_deployment" "app" {}\n',
    'packages/app-docker/k8s/manifests/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n',
  };

  it('a Helm chart, a Terraform sample and sample manifests are not rejections', () => {
    expect(checkKubernetes(chart).detected).toBe(false);
    expect(checkTerraform(terraform).detected).toBe(false);
    expect(checkKubernetes(terraform).detected).toBe(false);
    expect(checkPersistentVolumes({ 'k8s/pvc.yaml': 'kind: PersistentVolumeClaim\n' }).detected).toBe(false);
    expect(checkPulumi({ 'deploy/Pulumi.yaml': 'name: demo\n' }).detected).toBe(false);
  });

  it('records the ignored files and the readiness gate shows a warning, not an error', () => {
    const analysis = analyseRepo(chart);
    expect(analysis.rejections.filter((r) => r.detected && ['kubernetes', 'terraform'].includes(r.dependency))).toEqual([]);
    expect(analysis.metadata['ignoredDeploymentFiles']).toEqual(['charts/app/Chart.yaml']);

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.ignoredDeploymentFiles).toEqual(['charts/app/Chart.yaml']);
    expect(manifest.unsupported).toEqual([]);
    const readiness = evaluateManifestReadiness(manifest, {});
    expect(readiness.findings).toContainEqual(expect.objectContaining({ id: 'deployment-files-ignored', severity: 'warning' }));
    expect(readiness.findings.filter((f) => f.severity === 'error' && f.id === 'unsupported')).toEqual([]);
  });

  it('a repository without such files carries no warning', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo({ Dockerfile: APP }), {});
    expect(manifest.ignoredDeploymentFiles).toBeUndefined();
  });
});

describe('compose volumes of a service that builds another Dockerfile', () => {
  const base = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { pg: '^8.0.0' } }),
    'docker/Dockerfile': 'FROM node:20\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n',
    'docker/Dockerfile.compose': 'FROM example/app:latest\nCOPY ./entry.sh /entry.sh\nENTRYPOINT ["sh", "/entry.sh"]\n',
  };
  it('ignores the volume of a compose-only wrapper image', () => {
    const tree = {
      ...base,
      'docker-compose.yml':
        'services:\n  main:\n    build:\n      context: ./docker\n      dockerfile: Dockerfile.compose\n    volumes:\n      - app_storage:/app/storage\n  postgres:\n    image: postgres:16\nvolumes:\n  app_storage:\n',
    };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });
  it('keeps the volume of the service that builds the selected Dockerfile', () => {
    const tree = {
      ...base,
      'docker-compose.yml':
        'services:\n  main:\n    build:\n      context: .\n      dockerfile: docker/Dockerfile\n    volumes:\n      - app_storage:/app/storage\n  postgres:\n    image: postgres:16\nvolumes:\n  app_storage:\n',
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });
});

describe('an option in a sample or a comment is not the requirement of the app', () => {
  it('ignores a Pulumi package in a deployment sample directory', () => {
    const tree = { 'package.json': '{}', 'deploy/pulumi/package.json': JSON.stringify({ dependencies: { '@pulumi/pulumi': '^3.0.0' } }) };
    expect(checkPulumi(tree).detected).toBe(false);
  });

  it('keeps rejecting a Pulumi package in the application', () => {
    const tree = { 'package.json': JSON.stringify({ dependencies: { '@pulumi/pulumi': '^3.0.0' } }) };
    expect(checkPulumi(tree).detected).toBe(true);
  });

  it('ignores a rediss:// URL that an env sample only mentions in a comment', () => {
    const tree = { '.env.example': 'REDIS_URL= # used for jobs: rediss://:password@host:port\n' };
    expect(checkRedisUnsupported(tree).detected).toBe(false);
  });

  it('keeps rejecting a rediss:// URL that an env sample sets', () => {
    const tree = { '.env.example': 'REDIS_URL=rediss://:password@host:6380\n' };
    expect(checkRedisUnsupported(tree).detected).toBe(true);
  });
});

describe('an S3 backend that a settings file switches on by environment', () => {
  const settings = [
    'import os',
    'if "AWS_STORAGE_BUCKET_NAME" in os.environ:',
    '    STORAGES["default"]["BACKEND"] = "storages.backends.s3boto3.S3Boto3Storage"',
    '',
  ].join('\n');

  it('accepts a media VOLUME when the settings select the S3 backend and no requirements file is collected', () => {
    const tree: FileTree = { Dockerfile: `${APP}VOLUME /code/app/media/images/\n`, 'app/settings/production.py': settings };
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('keeps rejecting a media VOLUME when the settings name no bucket variable', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}VOLUME /code/app/media/images/\n`,
      'app/settings/production.py': 'STORAGES["default"]["BACKEND"] = "storages.backends.s3boto3.S3Boto3Storage"\n',
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });

  it('keeps rejecting a media VOLUME when only a bucket variable exists', () => {
    const tree: FileTree = {
      Dockerfile: `${APP}VOLUME /code/app/media/images/\n`,
      'app/settings/production.py': 'BUCKET = os.environ.get("AWS_STORAGE_BUCKET_NAME")\n',
    };
    expect(detectLocalFilesystem(tree).detected).toBe(true);
  });
});

describe('an image-only sidecar that only calls the app', () => {
  const app = ['  api:', '    image: ghcr.io/acme/app:latest', '    ports:', '      - "8000:8000"'];
  const db = ['  db:', '    image: mariadb:11'];

  it('does not count a port-less sidecar that waits on the app and that the app never names', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        ...app,
        ...db,
        '  vision:',
        '    image: ghcr.io/acme/app-vision:latest',
        '    depends_on:',
        '      api:',
        '        condition: service_healthy',
      ),
    };
    expect(multiService(tree)).toBe(false);
  });

  it('still counts a second image that publishes a port', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        ...app,
        '  vision:',
        '    image: ghcr.io/acme/app-vision:latest',
        '    ports:',
        '      - "8001:8000"',
        '    depends_on:',
        '      - api',
      ),
    };
    expect(multiService(tree)).toBe(true);
  });

  it('still counts a second image that the app names', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        ...app,
        '    environment:',
        '      VISION_URL: http://vision:8000',
        '  vision:',
        '    image: ghcr.io/acme/app-vision:latest',
        '    depends_on:',
        '      - api',
      ),
    };
    expect(multiService(tree)).toBe(true);
  });

  it('still counts a second image that does not wait on the app', () => {
    const tree: FileTree = {
      'docker-compose.yml': compose(
        'services:',
        ...app,
        '  frontend:',
        '    image: ghcr.io/acme/app-frontend:latest',
      ),
    };
    expect(multiService(tree)).toBe(true);
  });
});
