import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { checkDockerComposeMultiService, checkKafka, checkOtherUnsupportedDatabases, checkRabbitMq } from '../src/rejection.js';

const DOCKERFILE = 'FROM node:20-alpine\nCMD ["node", "server.js"]\n';

// A self-hoster Compose file that pulls published images does not say what the application needs.
const PUBLISHED_IMAGES = [
  'services:',
  '  app:',
  '    image: example/app:latest',
  '    ports:',
  '      - "3000:3000"',
  '  gateway:',
  '    image: example/gateway:latest',
  '    ports:',
  '      - "8787:8787"',
  '  broker:',
  '    image: rabbitmq:3-management',
  '  events:',
  '    image: confluentinc/cp-kafka:7.6.0',
  '  database:',
  '    image: paradedb/paradedb:latest-pg17',
  '',
].join('\n');

const BUILT_FROM_REPOSITORY = PUBLISHED_IMAGES.replace('    image: example/app:latest', '    build: .');

describe('a Compose file in a deployment directory that only pulls published images', () => {
  const tree: FileTree = { 'Dockerfile': DOCKERFILE, 'deploy/docker-compose.yml': PUBLISHED_IMAGES };

  it('is no evidence of a broker, a second application service or a PostgreSQL extension', () => {
    expect(checkRabbitMq(tree).detected).toBe(false);
    expect(checkKafka(tree).detected).toBe(false);
    expect(checkDockerComposeMultiService(tree).detected).toBe(false);
    expect(checkOtherUnsupportedDatabases(tree).detected).toBe(false);
  });

  it('is the default stack outside a deployment directory', () => {
    const root: FileTree = { 'Dockerfile': DOCKERFILE, 'docker/docker-compose.yml': PUBLISHED_IMAGES };
    expect(checkRabbitMq(root)).toMatchObject({ detected: true, dependency: 'rabbitmq' });
    expect(checkDockerComposeMultiService(root)).toMatchObject({ detected: true, dependency: 'docker-compose-multi-service' });
  });

  it('is evidence without a Dockerfile Deployz can build', () => {
    expect(checkRabbitMq({ 'deploy/docker-compose.yml': PUBLISHED_IMAGES })).toMatchObject({ detected: true, dependency: 'rabbitmq' });
  });

  it('does not hide a broker that the source connects to', () => {
    const connected: FileTree = {
      ...tree,
      'pyproject.toml': '[project]\ndependencies = [\n  "pika",\n]\n',
      'app/default_settings.py': 'RABBITMQ_HOST = "127.0.0.1"\n',
    };
    expect(checkRabbitMq(connected)).toMatchObject({ detected: true, dependency: 'rabbitmq' });
  });
});

describe('a Compose file that builds the application from the repository', () => {
  const tree: FileTree = { 'Dockerfile': DOCKERFILE, 'deploy/docker-compose.yml': BUILT_FROM_REPOSITORY };

  it('still counts its broker, its second application service and its PostgreSQL extension image', () => {
    expect(checkRabbitMq(tree)).toMatchObject({ detected: true, dependency: 'rabbitmq' });
    expect(checkKafka(tree)).toMatchObject({ detected: true, dependency: 'kafka' });
    expect(checkDockerComposeMultiService(tree)).toMatchObject({ detected: true, dependency: 'docker-compose-multi-service' });
    expect(checkOtherUnsupportedDatabases(tree)).toMatchObject({ detected: true, dependency: 'other-database' });
  });
});
