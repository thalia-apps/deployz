import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SidebarInset already renders the page's <main>. A second <main> inside it is
// invalid HTML and gives screen readers two main landmarks.
describe('app shells render one main landmark', () => {
  it.each(['dashboard-shell.tsx', 'admin-shell.tsx'])('%s adds no <main> inside SidebarInset', (file) => {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
    expect(source).toMatch(/<SidebarInset[\s>]/);
    expect(source).not.toMatch(/<main[\s>]/);
  });
});
