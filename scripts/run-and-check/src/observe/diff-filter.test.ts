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

describe('tool config, generated node_modules files and image volumes', () => {
  it('ignores Prisma CLI config and files generated under node_modules', () => {
    const ghostfolio = ['C /home', 'C /home/node', 'A /home/node/.config', 'A /home/node/.config/prisma-nodejs', 'A /home/node/.config/prisma-nodejs/commands.json'];
    expect(filterLocalDiskWrites(ghostfolio)).toEqual([]);
    const directus = ['C /directus', 'C /directus/node_modules', 'A /directus/node_modules/.directus/app-extensions/_virtual_entry.js'];
    expect(filterLocalDiskWrites(directus)).toEqual([]);
  });

  it('ignores the empty mount point of an image volume', () => {
    expect(filterLocalDiskWrites(['A /database'], ['/database'])).toEqual([]);
    expect(filterLocalDiskWrites(['A /database'])).toEqual(['/database']);
  });

  it('keeps real state next to the new rules', () => {
    const lines = ['A /data/docuseal/attachments/a.pdf', 'A /app/App_Data/tenants.json', 'A /home/node/.config/app/settings.json'];
    expect(filterLocalDiskWrites(lines, ['/database'])).toEqual(['/app/App_Data/tenants.json', '/data/docuseal/attachments/a.pdf', '/home/node/.config/app/settings.json']);
  });
});
