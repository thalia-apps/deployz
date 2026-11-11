import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { hasPreDeployMigration, selectProcfileReleaseCommand } from '../src/detectors.js';

function tree(procfile: string): FileTree {
  return {
    Dockerfile: 'FROM php:8.2-apache\nEXPOSE 80\nCMD ["apache2-foreground"]\n',
    Procfile: procfile,
  };
}

describe('selectProcfileReleaseCommand', () => {
  it.each([
    'php artisan migrate --force',
    'python manage.py migrate --noinput',
    'bundle exec rails db:migrate',
    'npx prisma migrate deploy',
  ])('returns the %s release line in any language', (command) => {
    const files = tree(`release: ${command}\nscheduler: php artisan schedule:work\n`);
    expect(selectProcfileReleaseCommand(files)).toBe(command);
    expect(hasPreDeployMigration(files)).toBe(true);
  });

  it.each(['php artisan migrate:fresh --force', 'php artisan db:seed --force', 'npx prisma migrate reset'])(
    'rejects the unsafe release line %s',
    (command) => {
      const files = tree(`release: ${command}\n`);
      expect(selectProcfileReleaseCommand(files)).toBeUndefined();
      expect(hasPreDeployMigration(files)).toBe(false);
    },
  );

  it('keeps a release line that chains an idempotent setup step', () => {
    const command = 'php artisan migrate --force && php artisan selfhost:setup';
    expect(selectProcfileReleaseCommand(tree(`release: ${command}\n`))).toBe(command);
  });

  it('returns nothing without a release line', () => {
    expect(selectProcfileReleaseCommand(tree('web: apache2-foreground\n'))).toBeUndefined();
  });
});
