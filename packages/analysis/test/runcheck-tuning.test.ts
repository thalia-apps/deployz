import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { detectEnvVarModel, detectGitCopyInDockerfile } from '../src/detectors.js';

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
    Dockerfile: `FROM ruby:3.4-alpine
RUN apk add --no-cache git
COPY . /app
${run}
CMD ["bundle", "exec", "rails", "s"]
`,
  });

  it('flags `RUN git rev-parse` without a fallback: the source archive has no .git', () => {
    expect(detectGitCopyInDockerfile(dockerfile('RUN git rev-parse HEAD > /app/.git_sha')).detected).toBe(true);
    expect(detectGitCopyInDockerfile(dockerfile('RUN bundle install && \
  git describe --tags > VERSION')).detected).toBe(true);
  });

  it('does not flag a git read with a fallback, a clone, or a command substitution', () => {
    expect(detectGitCopyInDockerfile(dockerfile('RUN git rev-parse HEAD > /app/.git_sha || echo unknown > /app/.git_sha')).detected).toBe(false);
    expect(detectGitCopyInDockerfile(dockerfile('RUN git clone https://github.com/a/b /src && cd /src && git rev-parse HEAD')).detected).toBe(false);
    expect(detectGitCopyInDockerfile(dockerfile('RUN go build -ldflags "-X main.sha=$(git rev-parse HEAD)" .')).detected).toBe(false);
  });
});
