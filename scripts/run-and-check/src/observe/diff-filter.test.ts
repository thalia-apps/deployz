import { describe, expect, it } from 'vitest';

import { filterLocalDiskWrites, sqliteFileWritten } from './diff-filter.js';

describe('filterLocalDiskWrites', () => {
  it('drops temp, run, log, cache and pid paths', () => {
    const lines = [
      'A /tmp/x',
      'C /var/tmp',
      'A /run/app.sock',
      'A /var/run/a',
      'C /proc/1',
      'A /dev/shm/x',
      'A /app/server.pid',
      'A /app/out.log',
      'A /root/.cache/pip/x',
      'A /home/node/.cache/yarn',
      'A /var/log/nginx/access',
      'A /var/cache/apt',
      'A /app/node_modules/.cache/babel',
      'A /app/pkg/__pycache__/m.pyc',
    ];
    expect(filterLocalDiskWrites(lines)).toEqual([]);
  });

  it('keeps real local state, sorted and without the change letter', () => {
    expect(filterLocalDiskWrites(['A /app/uploads/a.png', 'C /app', 'A /tmp/x', 'A /app/uploads/a.png'])).toEqual(['/app/uploads/a.png']);
  });

  it('does not treat a similar folder name as ignored', () => {
    expect(filterLocalDiskWrites(['A /tmpdata/x', 'A /runtime/y'])).toEqual(['/runtime/y', '/tmpdata/x']);
  });
});

describe('sqliteFileWritten', () => {
  it('detects sqlite and db files', () => {
    expect(sqliteFileWritten(['A /app/data.sqlite3'])).toBe(true);
    expect(sqliteFileWritten(['A /app/data.db'])).toBe(true);
    expect(sqliteFileWritten(['A /app/data.txt'])).toBe(false);
  });
});

describe('the CA mount point', () => {
  it('is not local state', () => {
    expect(filterLocalDiskWrites(['C /deployz', 'A /deployz/certs', 'A /app/uploads/a.txt'])).toEqual(['/app/uploads/a.txt']);
  });
});

describe('parent folders and runtime artefacts', () => {
  it('drops a parent whose changes are all ignored and keeps real files', () => {
    const umami = ['C /app', 'C /app/node_modules', 'A /app/node_modules/.cache/x', 'C /home', 'A /home/nextjs', 'A /home/nextjs/.npm/_logs/a.log'];
    expect(filterLocalDiskWrites(umami)).toEqual([]);
    const orchard = ['C /app', 'A /app/App_Data', 'A /app/App_Data/tenants.json', 'A /app/App_Data/Sites/Default/appsettings.json'];
    expect(filterLocalDiskWrites(orchard)).toEqual(['/app/App_Data/Sites/Default/appsettings.json', '/app/App_Data/tenants.json']);
  });

  it('ignores npm, pm2, tmp, cache, log folders, sockets and /etc', () => {
    const lines = ['A /root/.npm/_update-notifier-last-checked', 'A /directus/.pm2/dump.pm2', 'A /app/tmp/cache/bootsnap/x', 'A /app/gunicorn.ctl', 'C /etc/nginx/conf.d/default.conf', 'A /app/logs/app-audit.json'];
    expect(filterLocalDiskWrites(lines)).toEqual([]);
  });
});
