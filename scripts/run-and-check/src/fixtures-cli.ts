/**
 * `pnpm runcheck:fixtures [--no-observe]` — observes the ten known-answer
 * fixtures, then checks that the claim check gives the verdict each
 * `answers.json` expects. Exit code 1 on any wrong verdict.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { checkClaims } from './claims/check.js';
import { HARNESS_ROOT } from './claims/cli.js';
import { fixtureAnswersSchema, observationSchema, type FixtureAnswers, type Observation } from './contract.js';
import { main as observeMain } from './observe/cli.js';

export interface FixtureResult {
  fixture: string;
  wrong: string[];
}

/** The wrong verdicts of one fixture; an empty list is a pass. */
export function gradeFixture(answers: FixtureAnswers, observation: Observation): string[] {
  const wrong: string[] = [];
  const verdicts = checkClaims(
    answers.claims.map((answer) => answer.claim),
    observation,
  );
  answers.claims.forEach((answer, index) => {
    const got = verdicts[index]!;
    if (got.verdict !== answer.verdict) {
      const subject = answer.claim.subject === null ? '' : `[${answer.claim.subject}]`;
      wrong.push(`${answer.claim.type}${subject}=${String(answer.claim.value)}: expected ${answer.verdict}, got ${got.verdict} (${got.reason})`);
    }
  });
  const healthy = observation.runs[0]?.webHealthy.value === true;
  if (healthy !== answers.healthyWithAnalysedSettings) {
    wrong.push(`webHealthy: expected ${answers.healthyWithAnalysedSettings}, got ${healthy}`);
  }
  return wrong;
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { 'no-observe': { type: 'boolean' } }, strict: true });
  const fixturesDir = join(HARNESS_ROOT, 'fixtures');
  const ids = readdirSync(fixturesDir)
    .filter((name) => /^F\d+$/.test(name))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  if (!values['no-observe']) await observeMain(['--repo', ids.join(',')]);

  const results: FixtureResult[] = ids.map((fixture) => {
    const observationFile = join(HARNESS_ROOT, 'observations', `${fixture}.json`);
    if (!existsSync(observationFile)) return { fixture, wrong: ['no observation'] };
    const answers = fixtureAnswersSchema.parse(JSON.parse(readFileSync(join(fixturesDir, fixture, 'answers.json'), 'utf8')));
    const observation = observationSchema.parse(JSON.parse(readFileSync(observationFile, 'utf8')));
    return { fixture, wrong: gradeFixture(answers, observation) };
  });
  for (const { fixture, wrong } of results) {
    console.log(`${fixture}: ${wrong.length === 0 ? 'PASS' : 'FAIL'}`);
    for (const line of wrong) console.log(`  ${line}`);
  }
  const passed = results.filter((result) => result.wrong.length === 0).length;
  console.log(`fixtures: ${passed}/${results.length} pass`);
  if (passed !== results.length) process.exitCode = 1;
}
