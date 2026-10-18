import type { AnalysisResultFile, Claim } from '../contract.js';
import type { BuildRequest, BuiltImage, ProductionEnvironmentFn, Runner, Services } from '../ports.js';

export interface ObserveDeps {
  buildImage(req: BuildRequest): Promise<BuiltImage>;
  services: Services;
  runner: Runner;
  env: ProductionEnvironmentFn;
  now(): Date;
  log(line: string): void;
  /** Waits without blocking; the default is `setTimeout`. Tests pass a fake. */
  sleep?(ms: number): Promise<void>;
}

export interface ObserveOptions {
  force: boolean;
  observationsDir: string;
  runsDir: string;
  analyses: AnalysisResultFile[];
  /** Extra claims to probe (the fixtures' `answers.json` claims). */
  claims?: Claim[];
  harnessVersion: string;
  fixtureDir?: string;
}
