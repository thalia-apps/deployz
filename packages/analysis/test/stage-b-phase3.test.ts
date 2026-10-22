import { describe, expect, it } from 'vitest';

import type { AnalysisResult } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectEnvVarModel, classifyEnvVarPurpose, type FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, generatedEnvKeys, normalizeDeploymentManifest } from '../src/manifest.js';

function modelByKey(tree: FileTree) {
  return new Map(detectEnvVarModel(tree).map((entry) => [entry.key, entry]));
}

// ==========================================================================
// Node/TS: zod, envalid, throwing env() helper
// ==========================================================================

describe('env reads via schema libraries (COMP-017)', () => {
  it('Node: zod object members without default/optional are required reads', () => {
    const tree: FileTree = {
      'config/env.ts': [
        "import { z } from 'zod';",
        '',
        'export const env = z',
        '  .object({',
        '    CORE_SECRET: z.string().min(1),',
        '    NEXTAUTH_SECRET: z.string(),',
        "    DATABASE_URL: z.string().min(1, { message: 'db url' }),",
        "    LOG_LEVEL: z.string().default('info'),",
        '    PORT: z.coerce.number().default(3000),',
        '  })',
        '  .parse(process.env);',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('CORE_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('NEXTAUTH_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
    // A schema default is a real usable default — never a vendor requirement.
    expect(byKey.get('LOG_LEVEL')!.source.some((s) => s.startsWith('read in '))).toBe(true);
  });

  it('Node: envalid str()/str({desc}) are required; devDefault/default are not', () => {
    const tree: FileTree = {
      'config/env.ts': [
        "import { cleanEnv, str, num } from 'envalid';",
        '',
        'export const env = cleanEnv(process.env, {',
        '  ACCESS_TOKEN_SALT: str(),',
        "  JWT_SECRET: str({ desc: 'signing secret' }),",
        "  SESSION_SECRET: str({ default: 'dev-only' }),",
        '  PORT: num({ default: 3000 }),',
        '});',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('ACCESS_TOKEN_SALT')).toMatchObject({ required: true });
    expect(byKey.get('JWT_SECRET')).toMatchObject({ required: true });
    expect(byKey.get('SESSION_SECRET')).toMatchObject({ required: false });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
  });

  it('Node: a throwing env("KEY") helper marks its calls required', () => {
    const tree: FileTree = {
      'config/env.ts': [
        'function env(key: string): string {',
        '  const value = process.env[key];',
        '  if (!value) throw new Error(`missing env ${key}`);',
        '  return value;',
        '}',
        '',
        'export const coreSecret = env("CORE_SECRET");',
        "export const logLevel = process.env.LOG_LEVEL || 'info';",
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('CORE_SECRET')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// Python: pydantic v2 BaseSettings
// ==========================================================================

describe('Python pydantic-settings reads (COMP-017)', () => {
  const tree: FileTree = {
    'config/settings.py': [
      'from typing import Optional',
      'from pydantic import Field',
      'from pydantic_settings import BaseSettings',
      '',
      'class Settings(BaseSettings):',
      '    DATABASE_URL: str',
      '    SECRET_KEY: str = Field(...)',
      "    DB_HOST: str = Field(alias='DATABASE_HOST')",
      "    LOG_LEVEL: str = 'info'",
      '    OPTIONAL_FLAG: Optional[str] = None',
      '',
    ].join('\n'),
  };

  it('marks default-less typed fields required and defaulted/optional fields optional', () => {
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('SECRET_KEY')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('DATABASE_HOST')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('OPTIONAL_FLAG')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// JVM, Go, .NET
// ==========================================================================

describe('JVM / Go / .NET env reads (COMP-017)', () => {
  it('JVM: @Value("${KEY}") is required unless a :default is present; System.getenv is optional', () => {
    const tree: FileTree = {
      'src/main/java/com/app/EnvConfig.java': [
        'package com.app;',
        'import org.springframework.beans.factory.annotation.Value;',
        'public class EnvConfig {',
        '  @Value("${DATABASE_URL}")',
        '  private String dbUrl;',
        '  @Value("${REDIS_URL:redis://localhost:6379}")',
        '  private String redis;',
        '  @Value("${db.host}")',
        '  private String host;',
        '  public String token() { return System.getenv("INTERNAL_API_TOKEN"); }',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('REDIS_URL')).toMatchObject({ required: false });
    expect(byKey.get('INTERNAL_API_TOKEN')).toMatchObject({ required: false, secret: true });
    expect(byKey.has('DB')).toBe(false);
  });

  it('Go: plain os.Getenv is optional; an if-empty log.Fatal or required tag makes it required', () => {
    const tree: FileTree = {
      'main.go': [
        'package main',
        '',
        'import (',
        '  "log"',
        '  "os"',
        ')',
        '',
        'type Config struct {',
        '  Port  int    `envconfig:"PORT"`',
        '  Token string `envconfig:"AUTH_TOKEN,required"`',
        '  Base  string `envconfig:"BASE_URL" validate:"required"`',
        '}',
        '',
        'func main() {',
        '  apiKey := os.Getenv("API_KEY")',
        '  dbHost := os.Getenv("DB_HOST")',
        '  if os.Getenv("REQUIRED_TOKEN") == "" {',
        '    log.Fatal("REQUIRED_TOKEN must be set")',
        '  }',
        '  _ = apiKey',
        '  _ = dbHost',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('API_KEY')).toMatchObject({ required: false, secret: true });
    expect(byKey.get('DB_HOST')).toMatchObject({ required: false });
    expect(byKey.get('REQUIRED_TOKEN')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('AUTH_TOKEN')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('BASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
  });

  it('Go: envdecode/caarlos0-env `env:"KEY"` struct tags (DEPLOY-032, fider)', () => {
    const tree: FileTree = {
      'app/pkg/env/env.go': [
        'package env',
        '',
        'type Config struct {',
        '  BaseURL   string `env:"BASE_URL"`',
        '  JWTSecret string `env:"JWT_SECRET,required"`',
        '  URL       string `env:"DATABASE_URL,required"`',
        '  NoReply   string `env:"EMAIL_NOREPLY,required"`',
        '  Region    string `env:"EMAIL_MAILGUN_REGION,default=US"`',
        '  Port      string `env:"PORT,required" envDefault:"3000"`',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('PORT')).toMatchObject({ required: false });
    expect(byKey.get('JWT_SECRET')).toMatchObject({ required: true, secret: true, purpose: 'internal_secret' });
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('EMAIL_NOREPLY')).toMatchObject({ required: true, secret: false, purpose: 'optional_configuration' });
    expect(byKey.get('EMAIL_MAILGUN_REGION')).toMatchObject({ required: false });
    expect(byKey.get('BASE_URL')).toMatchObject({ required: false });
  });

  it('Go: an envconfig-only file is unaffected by the envdecode `env:"KEY"` tag scan', () => {
    const tree: FileTree = {
      'main.go': [
        'package main',
        '',
        'type Config struct {',
        '  Port  int    `envconfig:"PORT"`',
        '  Token string `envconfig:"AUTH_TOKEN,required"`',
        '}',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('AUTH_TOKEN')).toMatchObject({ required: true, secret: true });
    expect(byKey.get('PORT')).toMatchObject({ required: false });
    expect(byKey.size).toBe(2);
  });

  it('.NET: GetConnectionString with a ?? throw guard and GetRequiredSection are required', () => {
    const tree: FileTree = {
      'Program.cs': [
        'var builder = WebApplication.CreateBuilder(args);',
        'var conn = builder.Configuration.GetConnectionString("DATABASE_URL")',
        '  ?? throw new InvalidOperationException("DATABASE_URL not configured");',
        'var section = builder.Configuration.GetRequiredSection("SECRET_SECTION");',
        'var optional = builder.Configuration.GetConnectionString("OPTIONAL_CONNECTION");',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('ConnectionStrings__DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('SECRET_SECTION')).toMatchObject({ required: true });
    expect(byKey.get('ConnectionStrings__OPTIONAL_CONNECTION')).toMatchObject({ required: false });
  });
});

// ==========================================================================
// Purpose classification
// ==========================================================================

describe('env-var purpose classification (Stage B phase 3)', () => {
  it('classifies infra names high, catalog credentials high, aliases/secret-names medium', () => {
    expect(classifyEnvVarPurpose('DATABASE_URL')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'high',
    });
    expect(classifyEnvVarPurpose('MEMOS_DSN')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('PAPERLESS_DBHOST')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('S3_ATTACHMENTS_BUCKET')).toEqual({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('STRIPE_SECRET_KEY')).toEqual({
      purpose: 'external_credential',
      confidence: 'high',
    });
    expect(classifyEnvVarPurpose('INTERNAL_API_TOKEN')).toEqual({
      purpose: 'internal_secret',
      confidence: 'medium',
    });
    expect(classifyEnvVarPurpose('LOG_LEVEL')).toEqual({
      purpose: 'optional_configuration',
      confidence: 'medium',
    });
  });

  it('never calls a provisioned-resource or mail credential an internal secret (DEPLOY-013)', () => {
    // Discrete connection parts under the DB_* family are bindings (DEPLOY-005).
    expect(classifyEnvVarPurpose('DB_HOST')).toEqual({ purpose: 'infrastructure_binding', confidence: 'high' });
    expect(classifyEnvVarPurpose('DB_PASSWORD')).toEqual({ purpose: 'infrastructure_binding', confidence: 'high' });
    // A credential of a provisioned resource the binding phase does not name is still a binding.
    expect(classifyEnvVarPurpose('REDIS_PASSWORD')).toEqual({ purpose: 'infrastructure_binding', confidence: 'medium' });
    expect(classifyEnvVarPurpose('POSTGRES_PASSWORD')).toEqual({ purpose: 'infrastructure_binding', confidence: 'medium' });
    // A mail relay's credential is the vendor's provider secret.
    expect(classifyEnvVarPurpose('MAIL_PASSWORD')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('SMTP_PASS')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    // An application-internal secret stays mintable.
    expect(classifyEnvVarPurpose('JWT_SECRET')).toEqual({ purpose: 'internal_secret', confidence: 'medium' });
  });

  it('never calls a name with an inner provider token, a nested mail credential or composite TLS material an internal secret (DEPLOY-030, fider)', () => {
    // fider's real minting incident on analysis v23: the provider-prefix rule
    // only looked at the start of the name.
    expect(classifyEnvVarPurpose('EMAIL_AWSSES_ACCESS_KEY_ID')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('BLOB_STORAGE_S3_ACCESS_KEY_ID')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('EMAIL_SMTP_PASSWORD')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('EMAIL_MAILGUN_API')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('SSL_CERT_KEY')).toEqual({ purpose: 'optional_configuration', confidence: 'high' });
    expect(classifyEnvVarPurpose('JWT_SECRET')).toEqual({ purpose: 'internal_secret', confidence: 'medium' });
    expect(classifyEnvVarPurpose('AWS_S3_BUCKET')).toEqual({ purpose: 'infrastructure_binding', confidence: 'high' });
    expect(classifyEnvVarPurpose('S3_ATTACHMENTS_BUCKET')).toEqual({ purpose: 'infrastructure_binding', confidence: 'medium' });
  });

  it('never calls a provider-prefixed name, TLS material, or a location-shaped name an internal secret (DEPLOY-030)', () => {
    // outline's real minting incident: these all contain KEY/SECRET/TOKEN and
    // matched no external-credential shape, so the relay minted them as if
    // they were application-internal — switching on integrations and TLS
    // config nobody configured.
    expect(classifyEnvVarPurpose('AWS_ACCESS_KEY_ID')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('DROPBOX_APP_KEY')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('GITHUB_WEBHOOK_SECRET')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('SLACK_VERIFICATION_TOKEN')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    expect(classifyEnvVarPurpose('OIDC_TOKEN_URI')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    // outline's SSL_KEY: `@CannotUseWithout("SSL_CERT")` — TLS material is
    // configuration the vendor supplies as a pair, never a mintable secret.
    expect(classifyEnvVarPurpose('SSL_KEY')).toEqual({ purpose: 'optional_configuration', confidence: 'high' });
    expect(classifyEnvVarPurpose('TLS_CERT')).toEqual({ purpose: 'optional_configuration', confidence: 'high' });
    expect(classifyEnvVarPurpose('HTTPS_PRIVATE_KEY')).toEqual({ purpose: 'optional_configuration', confidence: 'high' });
    // A name ending in URI/URL/ENDPOINT/HOST names a location, never a
    // secret, even with TOKEN/KEY in it.
    expect(classifyEnvVarPurpose('OIDC_DISCOVERY_ENDPOINT')).toEqual({ purpose: 'external_credential', confidence: 'high' });
    // Deployz-injected storage bindings keep their purpose: the provider
    // prefix shape must not outrank the curated infra-binding names/aliases.
    expect(classifyEnvVarPurpose('AWS_S3_BUCKET')).toEqual({ purpose: 'infrastructure_binding', confidence: 'high' });
    expect(classifyEnvVarPurpose('S3_ATTACHMENTS_BUCKET')).toEqual({ purpose: 'infrastructure_binding', confidence: 'medium' });
    // These stay application-internal secrets — no provider prefix, no TLS
    // shape, no location suffix.
    for (const key of [
      'JWT_SECRET',
      'SECRET_KEY',
      'UTILS_SECRET',
      'APP_SECRET',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'NEXTAUTH_SECRET',
      'COOKIE_SECRET',
      'CORE_SECRET',
      'AUTH_SECRET',
      'SECRET_KEY_BASE',
    ]) {
      expect(classifyEnvVarPurpose(key), key).toEqual({ purpose: 'internal_secret', confidence: 'medium' });
    }
  });

  it('populates purpose/confidence on the env-var model entries', () => {
    const tree: FileTree = {
      '.env.example': [
        'STRIPE_SECRET_KEY=',
        'DATABASE_URL=',
        'MEMOS_DSN=',
        'INTERNAL_API_TOKEN=',
        'LOG_LEVEL=info',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('STRIPE_SECRET_KEY')).toMatchObject({
      purpose: 'external_credential',
      confidence: 'high',
      secret: true,
    });
    expect(byKey.get('DATABASE_URL')).toMatchObject({
      purpose: 'infrastructure_binding',
      confidence: 'high',
    });
    expect(byKey.get('MEMOS_DSN')).toMatchObject({
      purpose: 'infrastructure_binding',
      confidence: 'medium',
    });
    expect(byKey.get('INTERNAL_API_TOKEN')).toMatchObject({
      purpose: 'internal_secret',
      confidence: 'medium',
    });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({
      purpose: 'optional_configuration',
      confidence: 'medium',
    });
  });
});

// ==========================================================================
// End to end: a schema-required secret drives the manifest gate
// ==========================================================================

describe('schema-required secrets reach the deployment gate', () => {
  const tree: FileTree = {
    'Dockerfile': [
      'FROM node:20-alpine',
      'EXPOSE 3000',
      'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/config.ts': [
      "import { z } from 'zod';",
      'export const env = z',
      '  .object({',
      '    NEXTAUTH_SECRET: z.string().min(1),',
      "    LOG_LEVEL: z.string().default('info'),",
      '  })',
      '  .parse(process.env);',
      '',
    ].join('\n'),
    'src/index.js': "app.listen(process.env.PORT || 3000);\n",
  };

  it('flags a schema-required secret and classifies it as Deployz-generated (never asked of the vendor)', () => {
    const analysis = analyseRepo(tree);
    const envVarModel = analysis.metadata['envVarModel'] as {
      key: string;
      required: boolean;
      secret: boolean;
    }[];
    const nextauth = envVarModel.find((entry) => entry.key === 'NEXTAUTH_SECRET');
    expect(nextauth).toMatchObject({ required: true, secret: true });
    const logLevel = envVarModel.find((entry) => entry.key === 'LOG_LEVEL');
    expect(logLevel).toMatchObject({ required: false });

    // #186: an application-INTERNAL secret Deployz generates is minted inside
    // the customer's account after install — the manifest gate counts it as
    // auto-provided and never blocks the deployment on it.
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(generatedEnvKeys(manifest)).toEqual(['NEXTAUTH_SECRET']);
    const result = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(result.state).toBe('READY');
    expect(result.findings.some((f) => f.id === 'required-env-vars-missing')).toBe(false);
  });

  it('stays optional when a default makes the schema read optional', () => {
    const analysis: AnalysisResult = analyseRepo(tree);
    const manifest = normalizeDeploymentManifest(analysis, {});
    const result = evaluateManifestReadiness(manifest, {
      providedEnvKeys: ['NEXTAUTH_SECRET'],
    });
    expect(result.state).toBe('READY');
  });
});

// ==========================================================================
// Sprint A1: variables the app writes itself and t3-env pass-through blocks
// ==========================================================================

describe('false-required env vars (A1-001, A1-002)', () => {
  it('does not require a variable the runtime source assigns itself', () => {
    const tree: FileTree = {
      'server.js': [
        'if (!process.env.EE_ENV_LOADED) {',
        "  process.env.EE_ENV_LOADED = 'true';",
        '}',
        "process.env.TF_CPP_MIN_LOG_LEVEL = '2';",
        'process.env.UV_THREADPOOL_SIZE = Math.max(os.cpus().length, 4);',
        'const size = Number(process.env.UV_THREADPOOL_SIZE);',
        'const secret = process.env.APP_SECRET;',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('EE_ENV_LOADED')).toMatchObject({ required: false });
    expect(byKey.get('TF_CPP_MIN_LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('UV_THREADPOOL_SIZE')).toMatchObject({ required: false });
    expect(byKey.get('APP_SECRET')).toMatchObject({ required: true });
  });

  it('does not treat a comparison as a variable write or a glob in a comment as a variable', () => {
    const tree: FileTree = {
      'server.js': [
        '// read process.env.NEXT_PUBLIC_* directly',
        'const token = process.env.SERVICE_SECRET;',
        "if (process.env.NODE_MODE == 'x') {}",
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.has('NEXT_PUBLIC_')).toBe(false);
    expect(byKey.get('SERVICE_SECRET')).toMatchObject({ required: true });
  });

  it('defers a t3-env runtimeEnv pass-through to the createEnv zod schema', () => {
    const tree: FileTree = {
      'src/env.ts': [
        'import { createEnv } from "@t3-oss/env-nextjs";',
        'import * as z from "zod";',
        'export const env = createEnv({',
        '  server: {',
        '    DATABASE_URL: z.url(),',
        '    SECRET_PASSWORD: z.string().min(32),',
        '    OPENAI_API_KEY: z.string().optional(),',
        '    GOOGLE_CLIENT_SECRET: z.string().optional(),',
        '  },',
        '  runtimeEnv: {',
        '    DATABASE_URL: process.env.DATABASE_URL,',
        '    SECRET_PASSWORD: process.env.SECRET_PASSWORD,',
        '    OPENAI_API_KEY: process.env.OPENAI_API_KEY,',
        '    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,',
        '  },',
        '});',
        '',
      ].join('\n'),
      'src/analytics.ts': 'const apiKey = process.env.OPENAI_API_KEY;\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('SECRET_PASSWORD')).toMatchObject({ required: true });
    expect(byKey.get('OPENAI_API_KEY')).toMatchObject({ required: false });
    expect(byKey.get('GOOGLE_CLIENT_SECRET')).toMatchObject({ required: false });
  });

  it('reads an arithmetic default handed to a parsing helper', () => {
    const tree: FileTree = {
      'lib/tokens.js': 'const LOG_AGE = positiveInt(process.env.TOKEN_LOG_AGE, 7 * 24 * 3600);\n',
    };
    expect(modelByKey(tree).get('TOKEN_LOG_AGE')).toMatchObject({ required: false });
  });
  it('does not require a secret-named key that the same file tests for presence', () => {
    const tree: FileTree = {
      'api/auth.js': [
        'const secured = () => authIsConfigured || Boolean(process.env.API_TOKEN);',
        'const token = process.env.API_TOKEN;',
        '',
      ].join('\n'),
    };
    expect(modelByKey(tree).get('API_TOKEN')).toMatchObject({ required: false });
  });

  it('treats a key read after its own positive if-test as optional', () => {
    const tree: FileTree = {
      'config/version.js': [
        'const getVersion = () => {',
        '  if (process.env.APP_VERSION) {',
        '    return process.env.APP_VERSION;',
        '  }',
        "  return 'dev';",
        '};',
        '',
      ].join('\n'),
    };
    expect(modelByKey(tree).get('APP_VERSION')).toMatchObject({ required: false });
  });

  it('reads the default of a multi-line parse helper call (A1-007)', () => {
    const tree: FileTree = {
      'lib/options.ts': [
        'const limit = parseEnvVarNumber(',
        '  process.env.FEATURE_FLAGS_LIMIT,',
        '  options?.limits?.flags ?? 5000,',
        ');',
        'const max = parseEnvVarNumber(process.env.MAX_SESSIONS, isEnterprise ? 100 : 5);',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('FEATURE_FLAGS_LIMIT')).toMatchObject({ required: false });
    expect(byKey.get('MAX_SESSIONS')).toMatchObject({ required: false });
  });

  it('does not require a key the code tests against null before parsing it (A1-007)', () => {
    const tree: FileTree = {
      'lib/db.ts': [
        'const ssl = () => {',
        '  if (process.env.DATABASE_SSL != null) {',
        '    return JSON.parse(process.env.DATABASE_SSL);',
        '  }',
        '};',
        '',
      ].join('\n'),
    };
    expect(modelByKey(tree).get('DATABASE_SSL')).toMatchObject({ required: false });
  });

  it('treats a secret stored in a tested local as optional unless the code throws (A1-007)', () => {
    const optional: FileTree = {
      'lib/ai.ts': ['const aiKey = process.env.AI_API_KEY;', 'if (!aiKey) {', '  return disabled();', '}', ''].join('\n'),
    };
    const required: FileTree = {
      'lib/ai.ts': ['const aiKey = process.env.AI_API_KEY;', 'if (!aiKey) {', "  throw new Error('missing');", '}', ''].join('\n'),
    };
    const untested: FileTree = { 'lib/ai.ts': 'const aiKey = process.env.AI_API_KEY;\nclient(aiKey);\n' };
    expect(modelByKey(optional).get('AI_API_KEY')).toMatchObject({ required: false });
    expect(modelByKey(required).get('AI_API_KEY')).toMatchObject({ required: true });
    expect(modelByKey(untested).get('AI_API_KEY')).toMatchObject({ required: true });
  });

  it('ignores env reads of a sibling app the Dockerfile does not build (A1-008)', () => {
    const tree: FileTree = {
      'apps/web/Dockerfile': 'FROM node:20\nRUN turbo prune --scope=@acme/web\nCMD ["node", "apps/web/server.js"]\n',
      'apps/web/src/env.ts': 'const url = new URL(path, process.env.WEB_PUBLIC_URL);\nfetch(process.env.SHARED_API_URL);\n',
      'apps/landing/src/links.ts': 'const url = new URL(path, process.env.LANDING_BASE_URL);\n',
      'apps/worker/src/index.ts': 'fetch(process.env.WORKER_API_URL);\n',
      'packages/lib/src/index.ts': 'fetch(process.env.SHARED_LIB_URL);\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.has('LANDING_BASE_URL')).toBe(false);
    expect(byKey.has('WORKER_API_URL')).toBe(false);
    expect(byKey.has('WEB_PUBLIC_URL')).toBe(true);
    expect(byKey.has('SHARED_LIB_URL')).toBe(true);
  });

  it('keeps a sibling workload a compose service or a Procfile entry points at (A1-008)', () => {
    const base: FileTree = {
      'apps/web/Dockerfile': 'FROM node:20\nCMD ["node", "apps/web/server.js"]\n',
      'apps/web/src/env.ts': 'fetch(process.env.WEB_API_URL);\n',
      'apps/worker/src/index.ts': 'fetch(process.env.WORKER_API_URL);\n',
    };
    expect(
      modelByKey({ ...base, 'docker-compose.yml': 'services:\n  worker:\n    build: ./apps/worker\n' }).has('WORKER_API_URL'),
    ).toBe(true);
    expect(modelByKey({ ...base, Procfile: 'worker: node apps/worker/dist/index.js\n' }).has('WORKER_API_URL')).toBe(true);
    expect(modelByKey(base).has('WORKER_API_URL')).toBe(false);
  });

  it('drops a sibling app that only has its own Dockerfile: a release has one image (OpenShip)', () => {
    const tree: FileTree = {
      'apps/api/Dockerfile': 'FROM oven/bun\nCOPY apps/ ./apps/\nCMD ["bun", "run", "apps/api/dist/index.js"]\n',
      'apps/api/src/index.ts': 'fetch(process.env.API_UPSTREAM_URL);\n',
      'apps/dashboard/Dockerfile': 'FROM node:20\n',
      'apps/dashboard/src/lib/server/api.ts': 'fetch(process.env.INTERNAL_API_URL);\n',
      'apps/cli/build/stage.ts': 'fetch(process.env.CLI_RELEASE_URL);\n',
      // A build-override compose variant and a comment do not put a sibling in this image.
      'docker/docker-compose.build.yml': 'services:\n  dashboard:\n    build:\n      dockerfile: apps/dashboard/Dockerfile\n',
      'docker/docker-compose.yml': '# Keep in sync with apps/cli/src/lib/compose.ts\nservices:\n  api:\n    image: api\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('API_UPSTREAM_URL')).toMatchObject({ required: true });
    expect(byKey.has('INTERNAL_API_URL')).toBe(false);
    expect(byKey.has('CLI_RELEASE_URL')).toBe(false);
  });

  it('matches a sibling directory by its whole name (apps/cli is not apps/client)', () => {
    const tree: FileTree = {
      'apps/web/Dockerfile': 'FROM node:20\nCOPY apps/client apps/client\n',
      'apps/cli/src/index.ts': 'fetch(process.env.CLI_ONLY_URL);\n',
      'apps/client/src/index.ts': 'fetch(process.env.CLIENT_URL);\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.has('CLI_ONLY_URL')).toBe(false);
    expect(byKey.has('CLIENT_URL')).toBe(true);
  });

  it('requires a schema-optional key that a boot guard throws without (OpenShip INTERNAL_TOKEN)', () => {
    const tree: FileTree = {
      'src/env.ts': [
        "import { z } from 'zod';",
        'const envSchema = z.object({',
        '  INTERNAL_TOKEN: z.string().optional(),',
        '  OBLIEN_CLIENT_ID: z.string().optional(),',
        '  DEV_ONLY_TOKEN: z.string().optional(),',
        '  PLAIN_GUARDED: z.string().optional(),',
        '  BILLING_ENABLED: envBool("false"),',
        '});',
        'export const env = envSchema.parse(process.env);',
        'if (env.DEPLOY_MODE !== "desktop" && !env.INTERNAL_TOKEN) {',
        '  throw new Error("INTERNAL_TOKEN is required");',
        '}',
        'if (env.CLOUD_MODE && !env.OBLIEN_CLIENT_ID) throw new Error("cloud needs Oblien");',
        'if (env.NODE_ENV !== "production" && !env.DEV_ONLY_TOKEN) throw new Error("dev needs it");',
        'if (!env.PLAIN_GUARDED) throw new Error("missing");',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('INTERNAL_TOKEN')).toMatchObject({ required: true });
    expect(byKey.get('PLAIN_GUARDED')).toMatchObject({ required: true });
    expect(byKey.get('OBLIEN_CLIENT_ID')).toMatchObject({ required: false });
    expect(byKey.get('DEV_ONLY_TOKEN')).toMatchObject({ required: false });
    // A helper-built member is read (not "sample file only"), and that read never requires it.
    expect(byKey.get('BILLING_ENABLED')).toMatchObject({ required: false });
    expect(byKey.get('BILLING_ENABLED')!.source).toContain('read in src/env.ts');
  });

  it('does not let a .env.example value make a required read optional', () => {
    const tree: FileTree = {
      '.env.example': 'INTERNAL_TOKEN=change-me-32-byte-random-hex\nAPI_BASE_URL=http://localhost:4000\nLOG_LEVEL=info\n',
      'src/index.ts': 'fetch(process.env.API_BASE_URL);\nconst level = process.env.LOG_LEVEL ?? "warn";\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('API_BASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('INTERNAL_TOKEN')).toMatchObject({ required: false });
  });

  it('keeps a sibling app the Dockerfile itself names (A1-008)', () => {
    const tree: FileTree = {
      'apps/api/Dockerfile': 'FROM node:20\nCOPY apps/worker apps/worker\nCMD ["node", "apps/api/server.js"]\n',
      'apps/worker/src/index.ts': 'fetch(process.env.WORKER_API_URL);\n',
    };
    expect(modelByKey(tree).has('WORKER_API_URL')).toBe(true);
  });

  it('does not require a non-secret value handed alone to a named converter (A1-008)', () => {
    const tree: FileTree = {
      'lib/config.ts': [
        'const enabled = Boolean(process.env.FEATURE_FLAG);',
        'const base = formatBaseUri(process.env.BASE_URI_PATH);',
        'const type = authTypeFromString(process.env.AUTH_TYPE);',
        'const client = new Client(process.env.SERVICE_ENDPOINT);',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('FEATURE_FLAG')).toMatchObject({ required: false });
    expect(byKey.get('BASE_URI_PATH')).toMatchObject({ required: false });
    expect(byKey.get('AUTH_TYPE')).toMatchObject({ required: false });
    expect(byKey.get('SERVICE_ENDPOINT')).toMatchObject({ required: true });
    // Number(undefined) is NaN: the coercion alone does not handle absence.
    expect(modelByKey({ 'lib/n.ts': 'const id = Number(process.env.PARTITION_ID);\n' }).get('PARTITION_ID')).toMatchObject({
      required: true,
    });
  });

  it('requires a Dockerfile ARG without a default that compose feeds as a build arg (A1-009)', () => {
    const tree: FileTree = {
      'apps/web/Dockerfile': [
        'FROM node:24 AS installer',
        'ARG SELF_HOSTED',
        'ENV NEXT_PUBLIC_SELF_HOSTED=$SELF_HOSTED',
        'ARG WITH_DEFAULT=1',
        'ARG UNSET_IN_COMPOSE',
        'RUN pnpm build',
        '',
      ].join('\n'),
      'docker-compose.yml': [
        'services:',
        '  web:',
        '    build:',
        '      args:',
        '        - SELF_HOSTED=true',
        '        - WITH_DEFAULT=2',
        '      context: .',
        '      dockerfile: ./apps/web/Dockerfile',
        '',
      ].join('\n'),
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('SELF_HOSTED')).toMatchObject({ required: true, secret: false });
    expect(byKey.get('SELF_HOSTED')!.source).toEqual(['docker-compose.yml build arg SELF_HOSTED=true']);
    expect(byKey.has('WITH_DEFAULT')).toBe(false);
    expect(byKey.has('UNSET_IN_COMPOSE')).toBe(false);
  });

  it('accepts the mapping form of compose build args and hides a secret-looking value (A1-009)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:24\nARG NPM_TOKEN\nARG FEATURE\nRUN pnpm build\n',
      'compose.yaml': 'services:\n  web:\n    build:\n      args:\n        FEATURE: on\n        NPM_TOKEN: abc123\n',
    };
    const byKey = modelByKey(tree);
    expect(byKey.get('FEATURE')!.source).toEqual(['compose.yaml build arg FEATURE=on']);
    expect(byKey.get('NPM_TOKEN')!.source).toEqual(['compose.yaml build arg NPM_TOKEN']);
  });

  it('does not let a closed if-condition of an earlier statement guard a later bare read', () => {
    const tree: FileTree = {
      'server.js': ["if (process.env.MODE === 'x') {}", 'const token = process.env.SERVICE_SECRET;', ''].join('\n'),
    };
    expect(modelByKey(tree).get('SERVICE_SECRET')).toMatchObject({ required: true });
  });
});
