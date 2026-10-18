import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { detectEnvVarModel, detectGitCopyInDockerfile, detectPort } from '../src/detectors.js';

// Defects the Docker run-and-check test found in the tuning set: each claim
// was CONTRADICTED by the running application.

const NODE_PACKAGE = JSON.stringify({ dependencies: { express: '^4.19.0', envalid: '^8.0.0' } });

function requiredKeys(tree: FileTree): string[] {
  return detectEnvVarModel(tree)
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
}

describe('kutt (repo-003): optional variables', () => {
  it('does not require a variable read only behind a typeof presence test', () => {
    const migration = [
      'async function up(knex) {',
      '  if (typeof process.env.ADMIN_EMAILS === "string") {',
      '    const adminEmails = process.env.ADMIN_EMAILS.split(",").map((e) => e.trim());',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(requiredKeys({ 'package.json': NODE_PACKAGE, 'server/migrations/user-roles.js': migration })).not.toContain('ADMIN_EMAILS');
  });

  it('does not count `delete process.env.X` as a read of a defaulted variable', () => {
    const env = [
      'const { cleanEnv, str } = require("envalid");',
      'if (process.env.LINK_CUSTOM_ALPHABET === "") {',
      '  delete process.env.LINK_CUSTOM_ALPHABET;',
      '}',
      'module.exports = cleanEnv(process.env, { LINK_CUSTOM_ALPHABET: str({ default: "abc" }) });',
      '',
    ].join('\n');
    expect(requiredKeys({ 'package.json': NODE_PACKAGE, 'server/env.js': env })).not.toContain('LINK_CUSTOM_ALPHABET');
  });

  it('keeps a bare chained read without a presence test required', () => {
    const source = 'const emails = process.env.ADMIN_EMAILS.split(",");\n';
    expect(requiredKeys({ 'package.json': NODE_PACKAGE, 'server/admin.js': source })).toContain('ADMIN_EMAILS');
  });
});

describe('chatwoot (repo-071): a RUN step that reads git history', () => {
  const dockerfile = (run: string): FileTree => ({
    Dockerfile: `FROM ruby:3.4-alpine\nRUN apk add --no-cache git\nCOPY . /app\n${run}\nCMD ["bundle", "exec", "rails", "s"]\n`,
  });

  it('flags `RUN git rev-parse` without a fallback: the source archive has no .git', () => {
    expect(detectGitCopyInDockerfile(dockerfile('RUN git rev-parse HEAD > /app/.git_sha')).detected).toBe(true);
    expect(detectGitCopyInDockerfile(dockerfile('RUN bundle install && \\\n  git describe --tags > VERSION')).detected).toBe(true);
  });

  it('does not flag a git read with a fallback, a clone, or a command substitution', () => {
    expect(detectGitCopyInDockerfile(dockerfile('RUN git rev-parse HEAD > /app/.git_sha || echo unknown > /app/.git_sha')).detected).toBe(false);
    expect(detectGitCopyInDockerfile(dockerfile('RUN git clone https://github.com/a/b /src && cd /src && git rev-parse HEAD')).detected).toBe(false);
    expect(detectGitCopyInDockerfile(dockerfile('RUN go build -ldflags "-X main.sha=$(git rev-parse HEAD)" .')).detected).toBe(false);
  });
});

describe('docuseal (repo-051): Active Storage service credentials', () => {
  const gemfile = "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\ngem 'aws-sdk-s3'\n";
  const storage = [
    'disk:',
    '  service: Disk',
    "  root: <%= ENV['WORKDIR'] || '.' %>/attachments",
    'aws_s3:',
    '  service: S3',
    "  access_key_id: <%= ENV['AWS_ACCESS_KEY_ID'] %>",
    "  secret_access_key: <%= ENV['AWS_SECRET_ACCESS_KEY'] %>",
    'azure:',
    '  service: AzureBlob',
    "  storage_access_key: <%= ENV['AZURE_STORAGE_ACCESS_KEY'] %>",
    '',
  ].join('\n');

  it('does not require a credential read only in an optional storage.yml service block', () => {
    const required = requiredKeys({ Gemfile: gemfile, 'config/storage.yml': storage });
    expect(required).not.toContain('AWS_ACCESS_KEY_ID');
    expect(required).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(required).not.toContain('AZURE_STORAGE_ACCESS_KEY');
  });

  it('keeps ENV.fetch without a default required: it raises at boot', () => {
    const fetched = "amazon:\n  service: S3\n  secret_access_key: <%= ENV.fetch('AWS_SECRET_ACCESS_KEY') %>\n";
    expect(requiredKeys({ Gemfile: gemfile, 'config/storage.yml': fetched })).toContain('AWS_SECRET_ACCESS_KEY');
  });
});

describe('livebook (repo-050): the port the image checks itself on', () => {
  const tree = (healthcheck: string): FileTree => ({
    'mix.exs': 'defmodule Livebook.MixProject do\n  defp deps, do: [{:phoenix, "~> 1.7"}]\nend\n',
    Dockerfile: `FROM hexpm/elixir:1.18 AS build\nRUN mix release\nFROM ubuntu:24.04\nENV LIVEBOOK_IP="::"\n${healthcheck}\nCMD [ "/app/bin/server" ]\n`,
  });

  it('reads the port of a localhost HEALTHCHECK before the Phoenix default', () => {
    const port = detectPort(tree('HEALTHCHECK CMD wget --no-verbose --tries=1 --spider http://localhost:${LIVEBOOK_PORT-8080}/public/health || exit 1'));
    expect(port).toMatchObject({ value: '8080', portSource: 'dockerfile-expose' });
    expect(detectPort(tree('HEALTHCHECK CMD curl -f http://127.0.0.1:${PORT:-9000}/health')).value).toBe('9000');
  });

  it('keeps the framework default without a HEALTHCHECK port variable', () => {
    expect(detectPort(tree(''))).toMatchObject({ value: '4000', portSource: 'framework-default' });
    expect(detectPort(tree('HEALTHCHECK CMD curl -f http://localhost:4000/health'))).toMatchObject({ portSource: 'framework-default' });
  });
});
