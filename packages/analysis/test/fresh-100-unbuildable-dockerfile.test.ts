import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { TREE_PATHS, detectDockerfile, listDockerfileCandidates, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function withPaths(tree: Record<string, string>, extra: string[] = []): FileTree {
  Object.defineProperty(tree, TREE_PATHS, { value: [...Object.keys(tree), ...extra], enumerable: false });
  return tree;
}

function gate(tree: FileTree) {
  const analysis = analyseRepo(tree);
  const rejected = analysis.rejections.find((r) => r.detected && r.dependency === 'no-buildable-dockerfile');
  const state = evaluateManifestReadiness(normalizeDeploymentManifest(analysis, {})).state;
  return { rejected, state };
}

const APP = { 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }), 'index.js': 'listen(3000)\n' };

describe('a repository with no Dockerfile that builds a production image', () => {
  it('is NOT_COMPATIBLE when no Dockerfile exists', () => {
    const { rejected, state } = gate(withPaths({ ...APP }));
    expect(rejected?.reason).toContain('No Dockerfile exists');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile is a template', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, Dockerfile: '{{#ubi}}\nFROM ubi9\n{{/ubi}}\n{{^ubi}}\nFROM debian\n{{/ubi}}\nCMD ["node", "index.js"]\n' }),
    );
    expect(rejected?.reason).toContain('development or a template');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile is for development', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, 'Dockerfile.dev': 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["npm", "run", "dev"]\n' }),
    );
    expect(rejected).toBeDefined();
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when the only Dockerfile copies a prebuilt binary the repository lacks', () => {
    const { rejected, state } = gate(
      withPaths({ ...APP, Dockerfile: 'FROM alpine:3.20\nCOPY server /usr/bin/server\nEXPOSE 3000\nCMD ["server"]\n' }),
    );
    expect(rejected?.reason).toContain('server');
    expect(state).toBe('NOT_COMPATIBLE');
  });

  it('is NOT_COMPATIBLE when every Dockerfile that starts the app copies a CI build output (n8n shape)', () => {
    const { rejected, state } = gate(
      withPaths({
        ...APP,
        'docker/images/n8n/Dockerfile': 'FROM node:22-alpine\nCOPY ./compiled /usr/local/lib/node_modules/n8n\nEXPOSE 5678\nENTRYPOINT ["tini", "--", "n8n"]\n',
        'docker/images/runners/Dockerfile': 'FROM node:22-alpine\nCOPY ./dist/task-runner /app/task-runner\nCMD ["node", "/app/task-runner"]\n',
        'docker/images/base/Dockerfile': 'FROM node:22-alpine\nRUN npm install -g pnpm\nEXPOSE 5678\n',
      }),
    );
    expect(rejected?.reason).toContain('compiled');
    expect(state).toBe('NOT_COMPATIBLE');
  });
});

describe('evidence that is not complete never rejects (COMP-021)', () => {
  const missingSource = 'FROM alpine:3.20\nCOPY server /usr/bin/server\nEXPOSE 3000\nCMD ["server"]\n';

  it('does not reject without the full tracked path list', () => {
    expect(gate({ ...APP, Dockerfile: missingSource }).rejected).toBeUndefined();
    expect(gate({ ...APP }).rejected).toBeUndefined();
  });

  it('does not reject when a second candidate Dockerfile exists', () => {
    const tree = withPaths({ ...APP, Dockerfile: missingSource, 'docker/Dockerfile.web': 'FROM node:20\nCOPY . .\nCMD ["node", "index.js"]\n' });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject when a tracked Dockerfile was not fetched', () => {
    const tree = withPaths({ ...APP, Dockerfile: missingSource }, ['deploy/Dockerfile.prod']);
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject when a git submodule may hold the source', () => {
    const tree = withPaths({ ...APP, '.gitmodules': '[submodule "x"]\n', Dockerfile: missingSource });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject COPY --from= or a generated directory', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM golang:1.22 AS build\nRUN go build -o /out/app .\nFROM alpine\nCOPY --from=build /out/app /usr/bin/app\nCOPY dist ./dist\nEXPOSE 3000\nCMD ["app"]\n',
    });
    expect(gate(tree).rejected).toBeUndefined();
  });

  it('does not reject a buildable Dockerfile', () => {
    const tree = withPaths({ ...APP, Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n' });
    expect(gate(tree).rejected).toBeUndefined();
  });
});

describe('a Dockerfile under dev/', () => {
  const prod =
    'FROM node:20 AS build\nCOPY . .\nRUN npm run build\nFROM node:20-slim\nCOPY --from=build /dist ./dist\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n';

  it('is accepted and selected when it builds a production image', () => {
    const tree = withPaths({ ...APP, 'dev/Dockerfile': prod });
    expect(gate(tree).rejected).toBeUndefined();
    expect(listDockerfileCandidates(tree)).toEqual(['dev/Dockerfile']);
    expect(detectDockerfile(tree).value).toBe('dev/Dockerfile');
  });

  it('is rejected when it runs a development server, idles or only holds tooling', () => {
    const devServer = withPaths({ ...APP, 'dev/Dockerfile': 'FROM node:20\nCOPY . .\nCMD ["npm", "run", "dev"]\n' });
    expect(gate(devServer).rejected).toBeDefined();
    const tooling = withPaths({ ...APP, 'dev/Dockerfile': 'FROM node:20\nRUN apt-get update && apt-get install -y git\n' });
    expect(gate(tooling).rejected).toBeDefined();
    const idle = withPaths({ ...APP, 'dev/Dockerfile': 'FROM node:20\nCOPY . .\nCMD ["sleep", "infinity"]\n' });
    expect(gate(idle).rejected).toBeDefined();
  });

  it('keeps a .devcontainer Dockerfile rejected', () => {
    expect(gate(withPaths({ ...APP, '.devcontainer/Dockerfile': prod })).rejected).toBeDefined();
  });
});
