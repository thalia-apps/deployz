import { describe, expect, it } from 'vitest';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { derivedUrlEnvValue, isDerivedUrlEnvVariable } from '../src/derived-url.js';
import { classifyEnvVariables } from '../src/env-classification.js';
import { detectEnvVarModel, type FileTree } from '../src/detectors.js';

// Phase 4B — configuration friction. A key is required only when the app
// really refuses to start without it. The app's own public URL is derived.

const NODE_DOCKERFILE = 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "src/index.js"]\n';

function tree(files: FileTree): FileTree {
  return { Dockerfile: NODE_DOCKERFILE, 'package.json': '{"name":"app"}', ...files };
}

function find(files: FileTree, key: string) {
  return detectEnvVarModel(tree(files), []).find((entry) => entry.key === key);
}

const isRequired = (files: FileTree, key: string): boolean => find(files, key)?.required === true;

describe('build args and client build-time names', () => {
  const dockerfile = 'FROM node:20-alpine\nARG SELF_HOSTED\nARG BUILD_ID\nEXPOSE 3000\nCMD ["node","x.js"]\n';

  it('does not require a Dockerfile ARG that no compose file feeds', () => {
    expect(find({ Dockerfile: dockerfile }, 'SELF_HOSTED')).toBeUndefined();
  });

  it('requires a build arg that a production compose file sets to a literal value', () => {
    const files = { Dockerfile: dockerfile, 'docker-compose.yml': 'services:\n  web:\n    build:\n      args:\n        SELF_HOSTED: "true"\n' };
    expect(isRequired(files, 'SELF_HOSTED')).toBe(true);
  });

  it('does not require a build arg that compose only forwards from the environment', () => {
    const files = { Dockerfile: dockerfile, 'docker-compose.yml': 'services:\n  web:\n    build:\n      args:\n        - SELF_HOSTED=${SELF_HOSTED}\n' };
    expect(isRequired(files, 'SELF_HOSTED')).toBe(false);
  });

  it('does not require a build arg from a test or e2e compose file', () => {
    const files = { Dockerfile: dockerfile, 'e2e/docker-compose.yml': 'services:\n  web:\n    build:\n      args:\n        BUILD_ID: "1234"\n' };
    expect(isRequired(files, 'BUILD_ID')).toBe(false);
  });

  it('does not require a client build-time name read in a function call', () => {
    const files = { 'src/index.js': 'connect(process.env.NEXT_PUBLIC_OLLAMA_ENDPOINT_URL);\nboot(process.env.VITE_PLAUSIBLE_KEY);\n' };
    expect(isRequired(files, 'NEXT_PUBLIC_OLLAMA_ENDPOINT_URL')).toBe(false);
    expect(isRequired(files, 'VITE_PLAUSIBLE_KEY')).toBe(false);
  });

  it('keeps the own-address client name required (a build input), never derived', () => {
    const files = { 'src/index.js': 'const origin = new URL(process.env.NEXT_PUBLIC_BASE_URL).origin;\n' };
    expect(isRequired(files, 'NEXT_PUBLIC_BASE_URL')).toBe(true);
  });

  it('ignores a read in browser code', () => {
    const files = { 'client/src/api.js': 'fetch(process.env.BASE_URL + "/x");\n' };
    expect(isRequired(files, 'BASE_URL')).toBe(false);
  });
});

describe('reads that never need a value', () => {
  it('ignores reads in tests, e2e, playwright and storybook folders', () => {
    for (const path of ['tests/setup.js', 'e2e/run.js', 'playwright/utils.ts', '.storybook/main.js', 'docs/example.js']) {
      expect(find({ [path]: 'connect(process.env.SERVICE_PASSWORD);\n' }, 'SERVICE_PASSWORD')).toBeUndefined();
    }
  });

  it('does not require an optional integration credential read as an argument', () => {
    const files = { 'src/mail.js': 'const transport = createTransport(process.env.SMTP_PASSWORD, process.env.SENTRY_DSN);\n' };
    expect(isRequired(files, 'SMTP_PASSWORD')).toBe(false);
    expect(isRequired(files, 'SENTRY_DSN')).toBe(false);
  });

  it('does not require a tuning value read as an argument', () => {
    const files = { 'src/index.js': 'const max = Number(process.env.KAFKA_MAX_MESSAGE_BYTES);\nlimit(process.env.UPLOAD_LIMIT);\n' };
    expect(isRequired(files, 'KAFKA_MAX_MESSAGE_BYTES')).toBe(false);
    expect(isRequired(files, 'UPLOAD_LIMIT')).toBe(false);
  });

  it('does not require a Laravel config mail or social-login secret that has no default', () => {
    const files = { 'config/services.php': "<?php return ['pass' => env('MAIL_PASSWORD'), 'github' => env('GITHUB_CLIENT_SECRET'), 'key' => env('STORE_API_SECRET')];\n" };
    expect(isRequired(files, 'MAIL_PASSWORD')).toBe(false);
    expect(isRequired(files, 'GITHUB_CLIENT_SECRET')).toBe(false);
    expect(isRequired(files, 'STORE_API_SECRET')).toBe(true);
  });

  it('does not require a secret in a Laravel driver file, an OS name, or a flag read by a predicate', () => {
    const files = {
      'config/broadcasting.php': "<?php return ['ably' => ['key' => env('ABLY_KEY')]];\n",
      'config/cache.php': "<?php return ['memcached' => ['sasl' => [env('MEMCACHED_USERNAME'), env('MEMCACHED_PASSWORD')]]];\n",
      'server/browser.js': "const dir = process.env.LOCALAPPDATA + '/Chromium';\nconst keep = !isEnabled(process.env.STREAM_KEEP_COMPLETED_JOBS);\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\n",
    };
    for (const key of ['ABLY_KEY', 'MEMCACHED_PASSWORD', 'LOCALAPPDATA', 'STREAM_KEEP_COMPLETED_JOBS']) expect(isRequired(files, key)).toBe(false);
    expect(isRequired(files, 'STRIPE_SECRET_KEY')).toBe(true);
  });

  it('does not treat a Python assignment to os.environ as a read', () => {
    const files = { 'app/main.py': 'import os\nos.environ["MALLOC_ARENA_MAX"] = "2"\nx = os.environ["DATABASE_NAME"]\n' };
    expect(find(files, 'MALLOC_ARENA_MAX')).toBeUndefined();
    expect(isRequired(files, 'DATABASE_NAME')).toBe(true);
  });

  it('does not require a Ruby ENV.fetch with a block default or a presence test', () => {
    const files = {
      'config/initializers/web.rb':
        "backend = ENV.fetch('HTTP_BACKEND') { 'typhoeus' }\nif !ENV['BASIC_AUTH_PASSWORD'].to_s.empty?\n  use ENV.fetch('BASIC_AUTH_PASSWORD')\nend\nENV.fetch('SECRET_TOKEN')\n",
    };
    expect(isRequired(files, 'HTTP_BACKEND')).toBe(false);
    expect(isRequired(files, 'BASIC_AUTH_PASSWORD')).toBe(false);
    expect(isRequired(files, 'SECRET_TOKEN')).toBe(true);
  });

  it('does not treat a public key as a secret', () => {
    expect(find({ 'src/index.js': 'init(process.env.POSTHOG_PUBLIC_KEY);\n' }, 'POSTHOG_PUBLIC_KEY')?.secret).toBe(false);
  });
});

describe('boot-required values stay required', () => {
  it('requires a key that a boot guard throws without', () => {
    const files = { 'src/index.js': "if (!process.env.ADMIN_TOKEN) {\n  throw new Error('missing');\n}\nstart(process.env.ADMIN_TOKEN);\n" };
    expect(isRequired(files, 'ADMIN_TOKEN')).toBe(true);
  });

  it('does not count a guard inside a request handler or on a feature switch', () => {
    const files = {
      'src/handler.js':
        "async function report(req, res) {\n  if (!env.REPORT_EMAIL) {\n    throw new Error('none');\n  }\n}\nif (!process.env.MAIL_ENABLED) throw new Error('off');\n",
    };
    expect(isRequired(files, 'REPORT_EMAIL')).toBe(false);
    expect(isRequired(files, 'MAIL_ENABLED')).toBe(false);
  });

  it('requires an envalid value without a default and not one with a default', () => {
    const files = {
      'src/env.js': "const { cleanEnv, str } = require('envalid');\nmodule.exports = cleanEnv(process.env, {\n  API_TOKEN: str(),\n  MODE: str({ default: 'a' }),\n});\n",
    };
    expect(isRequired(files, 'API_TOKEN')).toBe(true);
    expect(isRequired(files, 'MODE')).toBe(false);
  });

  it('requires a zod value parsed at boot, not one parsed inside a function', () => {
    const boot = "import { z } from 'zod';\nconst schema = z.object({\n  LICENSE_KEY: z.string(),\n});\nexport const env = schema.parse(process.env);\n";
    const lazy =
      "import { z } from 'zod';\nconst schema = z.object({\n  SLACK_CLIENT_ID: z.string(),\n});\nexport function getSlackEnv() {\n  return schema.safeParse(process.env);\n}\n";
    expect(isRequired({ 'src/env.ts': boot }, 'LICENSE_KEY')).toBe(true);
    expect(isRequired({ 'src/slack.ts': lazy }, 'SLACK_CLIENT_ID')).toBe(false);
  });

  it('requires a Laravel config URL that has no default', () => {
    expect(isRequired({ 'config/filesystems.php': "<?php return ['url' => env('APP_URL').'/storage'];\n" }, 'APP_URL')).toBe(true);
  });
});

function variable(key: string, overrides: Partial<ManifestEnvVariable> = {}): ManifestEnvVariable {
  return { key, required: true, secret: false, source: ['read in src/server.ts'], ...overrides };
}

describe('derived application URL', () => {
  it('derives the app-owned URL names', () => {
    for (const key of [
      'PUBLIC_URL',
      'APP_URL',
      'BASE_URL',
      'SITE_URL',
      'ROOT_URL',
      'WEB_URL',
      'APP_BASE_URL',
      'PUBLIC_ORIGIN',
      'ORIGIN',
      'NEXTAUTH_URL',
      'AUTH_URL',
      'SITE_ROOT',
      'VERDACCIO_PUBLIC_URL',
      'PLANKA_BASE_URL',
      'MYAPP_EXTERNAL_URL',
    ]) {
      expect(isDerivedUrlEnvVariable(variable(key)), key).toBe(true);
      expect(derivedUrlEnvValue(variable(key), 'https://d-x.deployz.dev')).toBe('https://d-x.deployz.dev');
    }
  });

  it('never derives a provider endpoint, a client build-time name or an unrelated URL', () => {
    for (const key of [
      'OPENAI_BASE_URL',
      'STRIPE_PUBLIC_URL',
      'S3_PUBLIC_URL',
      'AWS_BASE_URL',
      'NEXT_PUBLIC_APP_URL',
      'VITE_BASE_URL',
      'REACT_APP_PUBLIC_URL',
      'API_URL',
      'DATABASE_URL',
      'WEBHOOK_URL',
    ]) {
      expect(isDerivedUrlEnvVariable(variable(key)), key).toBe(false);
      expect(derivedUrlEnvValue(variable(key), 'https://d-x.deployz.dev')).toBeNull();
    }
  });

  it('never derives an optional URL, a path sample or a browser-code read', () => {
    expect(isDerivedUrlEnvVariable(variable('APP_URL', { required: false }))).toBe(false);
    expect(isDerivedUrlEnvVariable(variable('BASE_URL', { source: ['read in src/server.ts', 'sample value is a path'] }))).toBe(false);
    expect(isDerivedUrlEnvVariable(variable('BASE_URL', { source: ['read in client/src/router.js'] }))).toBe(false);
  });

  it('classifies a required own-URL variable as Deployz-managed and keeps other URLs customer-required', () => {
    const none = { postgresRequired: false, redisRequired: false, redisBindingNames: [], storageRequired: false, externalServices: [], queueBindingNames: [] };
    const classified = classifyEnvVariables([variable('APP_URL'), variable('OPENAI_BASE_URL'), variable('NEXT_PUBLIC_APP_URL')], none);
    expect(classified.map((entry) => [entry.key, entry.classification])).toEqual([
      ['APP_URL', 'deployz_managed'],
      ['OPENAI_BASE_URL', 'customer_required'],
      ['NEXT_PUBLIC_APP_URL', 'customer_required'],
    ]);
  });

  it('marks a sample value that is a path', () => {
    const entry = find(
      { '.env.example': 'BASE_URL=/app\n', 'src/index.js': 'const base = process.env.BASE_URL.replace("/", "");\n' },
      'BASE_URL',
    );
    expect(entry?.source).toContain('sample value is a path');
    expect(entry && isDerivedUrlEnvVariable(entry)).toBe(false);
  });

  it('derives an app URL that the code reads with no default', () => {
    const entry = find({ 'src/index.js': 'const origins = process.env.BASE_URL.split(",");\n' }, 'BASE_URL');
    expect(entry?.required).toBe(true);
    expect(entry && isDerivedUrlEnvVariable(entry)).toBe(true);
  });
});
