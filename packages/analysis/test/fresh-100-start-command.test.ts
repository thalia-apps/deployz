import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { TREE_PATHS, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function withPaths(tree: Record<string, string>, extra: string[] = []): FileTree {
  Object.defineProperty(tree, TREE_PATHS, { value: [...Object.keys(tree), ...extra], enumerable: false });
  return tree;
}

function gate(tree: FileTree) {
  const analysis = analyseRepo(tree);
  const manifest = normalizeDeploymentManifest(analysis, {});
  const readiness = evaluateManifestReadiness(manifest);
  return {
    state: readiness.state,
    command: manifest.web.command,
    startMissing: readiness.findings.some((error) => error.id === 'start-command-missing'),
    multiProcess: analysis.rejections.find((r) => r.detected && r.dependency === 'multi-process-image'),
  };
}

const APP = {
  'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node index.js' } }),
  'index.js': 'listen(3000)\n',
};

describe('an image with no default server command has no start command', () => {
  it('flags a final stage on a bare OS base with no CMD and no ENTRYPOINT', () => {
    const dockerfile =
      'FROM node:20 AS build\nCOPY . .\nRUN npm ci\nFROM debian:bookworm-slim AS app\nCOPY --from=build /app ./\nEXPOSE 3000\nUSER nobody\n';
    const result = gate(withPaths({ ...APP, Dockerfile: dockerfile }));
    expect(result.startMissing).toBe(true);
    expect(result.command).toBeNull();
  });

  it('flags a launcher-only ENTRYPOINT with no CMD', () => {
    const dockerfile = 'FROM ruby:3.3\nCOPY . .\nEXPOSE 3000\nENTRYPOINT [ "bundle", "exec" ]\n';
    const result = gate(withPaths({ ...APP, Dockerfile: dockerfile }));
    expect(result.startMissing).toBe(true);
  });

  it('keeps a start command when the image has a CMD, or the launcher has a CMD', () => {
    expect(gate(withPaths({ ...APP, Dockerfile: 'FROM debian:12\nCOPY . .\nEXPOSE 3000\nCMD ["./server"]\n' })).startMissing).toBe(false);
    expect(
      gate(withPaths({ ...APP, Dockerfile: 'FROM ruby:3.3\nEXPOSE 3000\nENTRYPOINT ["bundle", "exec"]\nCMD ["rails", "server"]\n' })).startMissing,
    ).toBe(false);
  });

  it('keeps a start command when the ENTRYPOINT is a program', () => {
    expect(gate(withPaths({ ...APP, Dockerfile: 'FROM alpine:3.20\nCOPY server /server\nEXPOSE 3000\nENTRYPOINT ["/server"]\n' })).startMissing).toBe(false);
  });

  it('keeps a start command inherited from an earlier stage', () => {
    const dockerfile = 'FROM debian:12 AS runtime\nCMD ["./server"]\nFROM runtime AS final\nCOPY . .\nEXPOSE 3000\n';
    expect(gate(withPaths({ ...APP, Dockerfile: dockerfile })).startMissing).toBe(false);
  });
});

describe('an image that runs several supervised processes is not supported', () => {
  const s6Dockerfile = 'FROM debian:12\nADD https://example.test/s6-overlay-noarch.tar.xz /tmp\nCOPY rootfs/ /\nEXPOSE 3000\nENTRYPOINT ["/init"]\n';

  it('rejects s6-overlay with two long-running services', () => {
    const tree = withPaths({ ...APP, Dockerfile: s6Dockerfile }, [
      'rootfs/etc/s6-overlay/s6-rc.d/api/run',
      'rootfs/etc/s6-overlay/s6-rc.d/web/run',
      'rootfs/etc/s6-overlay/s6-rc.d/init-db/up',
    ]);
    const result = gate(tree);
    expect(result.multiProcess?.reason).toContain('s6-overlay');
    expect(result.state).toBe('NOT_COMPATIBLE');
  });

  it('rejects supervisord with two programs', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM python:3.12\nRUN pip install supervisor\nCOPY supervisord.conf /etc/supervisord.conf\nEXPOSE 3000\nCMD ["supervisord", "-c", "/etc/supervisord.conf"]\n',
      'supervisord.conf': '[program:web]\ncommand=gunicorn app\n[program:worker]\ncommand=celery worker\n',
    });
    expect(gate(tree).multiProcess?.reason).toContain('supervisord');
  });

  it('accepts s6-overlay with one service, and supervisord with one program', () => {
    const one = withPaths({ ...APP, Dockerfile: s6Dockerfile }, ['rootfs/etc/s6-overlay/s6-rc.d/web/run']);
    expect(gate(one).multiProcess).toBeUndefined();
    const supervised = withPaths({
      ...APP,
      Dockerfile: 'FROM python:3.12\nRUN pip install supervisor\nEXPOSE 3000\nCMD ["supervisord"]\n',
      'supervisord.conf': '[program:web]\ncommand=gunicorn app\n',
    });
    expect(gate(supervised).multiProcess).toBeUndefined();
  });

  it('accepts nginx and php-fpm under supervisord as one web service', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM php:8.3-fpm\nRUN apt-get install -y nginx supervisor\nCOPY supervisord.conf /etc/supervisord.conf\nEXPOSE 80\nCMD ["supervisord", "-c", "/etc/supervisord.conf"]\n',
      'supervisord.conf': '[program:nginx]\ncommand=nginx -g "daemon off;"\n[program:php-fpm]\ncommand=php-fpm -F\n',
    });
    expect(gate(tree).multiProcess).toBeUndefined();
  });

  it('accepts nginx and php-fpm under s6-overlay as one web service', () => {
    const tree = withPaths({ ...APP, Dockerfile: s6Dockerfile }, [
      'rootfs/etc/s6-overlay/s6-rc.d/nginx/run',
      'rootfs/etc/s6-overlay/s6-rc.d/php-fpm/run',
    ]);
    expect(gate(tree).multiProcess).toBeUndefined();
  });

  it('rejects a start script that puts two long-running servers in the background (Homarr)', () => {
    const run = [
      'node ./db/migrations/$DB_DIALECT/migrate.cjs ./db/migrations/$DB_DIALECT &',
      'wait "$MIGRATION_PID"',
      "nginx -g 'daemon off;' &",
      'redis-server /app/redis.conf &',
      'node apps/nextjs/server.js &',
      'while true; do',
      '    wait $NEXTJS_PID',
      '    node apps/nextjs/server.js &',
      'done',
    ].join('\n');
    const tree = withPaths({ ...APP, Dockerfile: 'FROM alpine:3.20\nCOPY scripts/run.sh ./run.sh\nEXPOSE 7575\nCMD ["sh", "run.sh"]\n', 'scripts/run.sh': run });
    expect(gate(tree).multiProcess?.reason).toContain('2 long-running servers in the background (redis-server /app/redis.conf, node apps/nextjs/server.js)');
  });

  it('accepts a start script with one background server, or nginx in front of the app', () => {
    const dockerfile = 'FROM node:22\nCOPY start.sh ./start.sh\nEXPOSE 3000\nCMD ["sh", "start.sh"]\n';
    expect(gate(withPaths({ ...APP, Dockerfile: dockerfile, 'start.sh': 'crond &\nexec node index.js\n' })).multiProcess).toBeUndefined();
    expect(gate(withPaths({ ...APP, Dockerfile: dockerfile, 'start.sh': 'nginx &\nnode index.js &\nwait\n' })).multiProcess).toBeUndefined();
  });

  it('rejects a supervisor that runs api, cron, web and worker', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM python:3.12\nRUN pip install supervisor\nCOPY supervisord.conf /etc/supervisord.conf\nEXPOSE 3000\nCMD ["supervisord"]\n',
      'supervisord.conf': '[program:api]\ncommand=uvicorn api\n[program:nginx]\ncommand=nginx\n[program:cron]\ncommand=cron -f\n[program:worker]\ncommand=celery worker\n',
    });
    expect(gate(tree).multiProcess?.reason).toContain('3 programs');
  });

  it('ignores a supervisord example that the Dockerfile does not copy', () => {
    const tree = withPaths({
      ...APP,
      Dockerfile: 'FROM python:3.12\nRUN pip install supervisor\nCOPY app/ /app/\nEXPOSE 3000\nCMD ["supervisord"]\n',
      'docs/examples/supervisord.conf': '[program:web]\ncommand=gunicorn app\n[program:worker]\ncommand=celery worker\n',
    });
    expect(gate(tree).multiProcess).toBeUndefined();
  });

  it('accepts a Dockerfile with no supervisor even when service directories exist', () => {
    const tree = withPaths({ ...APP, Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["node", "index.js"]\n' }, [
      'services.d/api/run',
      'services.d/web/run',
    ]);
    expect(gate(tree).multiProcess).toBeUndefined();
  });
});
