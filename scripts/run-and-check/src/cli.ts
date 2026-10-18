/** The one entry point of the `runcheck:*` commands: `tsx src/cli.ts <command> [args]`. */
import { main as analyse } from './analysis/cli.js';
import { main as claims } from './claims/cli.js';
import { main as preflight } from './docker/preflight-cli.js';
import { main as fixtures } from './fixtures-cli.js';
import { main as full } from './full-cli.js';
import { main as observe } from './observe/cli.js';

const COMMANDS: Record<string, (argv: string[]) => Promise<unknown> | unknown> = {
  analyse: async (argv) => {
    process.exitCode = await analyse(argv);
  },
  claims: (argv) => {
    process.exitCode = claims(argv);
  },
  full,
  fixtures,
  observe,
  preflight: () => preflight(),
};

const [command, ...argv] = process.argv.slice(2);
const run = command === undefined ? undefined : COMMANDS[command];
if (run === undefined) {
  console.error(`usage: runcheck <${Object.keys(COMMANDS).join('|')}> [args]`);
  process.exitCode = 2;
} else {
  await run(argv);
}
