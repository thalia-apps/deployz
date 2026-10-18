import { preflight } from './preflight.js';

export async function main(): Promise<void> {
  const report = await preflight();
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(10)} ${check.detail}`);
  }
  if (!report.ok) process.exitCode = 1;
}
