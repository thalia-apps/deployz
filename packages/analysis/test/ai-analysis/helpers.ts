import type { z } from 'zod';

import type { AiGateway, AiGatewayResponse, AiGenerateOptions } from '../../src/ai-gateway.js';
import type { BlockerAnswer, FactAnswer } from '../../src/ai-analysis/analyst.js';
import { TREE_PATHS, type FileTree } from '../../src/detectors.js';

export const cite = (path: string, line: number, quote: string) => [{ path, line, quote }];

/** A blocker answer; override what a test needs. */
export function blocker(id: string, answer: BlockerAnswer['answer'], overrides: Partial<BlockerAnswer> = {}): BlockerAnswer {
  return { id, answer, setting: null, settingValue: null, engine: null, confidence: 'high', evidence: [], ...overrides };
}

export function fact(id: string, value: string | null, overrides: Partial<FactAnswer> = {}): FactAnswer {
  return { id, value, confidence: 'high', evidence: [], ...overrides };
}

/** The answers in the flat wire format the provider returns. */
export function toWire(blockers: readonly BlockerAnswer[], facts: readonly FactAnswer[] = []) {
  return {
    answers: [
      ...blockers.map((answer) => ({ ...answer, value: null })),
      ...facts.map((answer) => ({
        id: answer.id,
        answer: answer.value === null ? 'unknown' : 'value',
        setting: null,
        settingValue: null,
        engine: null,
        value: answer.value,
        confidence: answer.confidence,
        evidence: answer.evidence,
      })),
    ],
  };
}

export interface FakeGateway extends AiGateway {
  readonly prompts: string[];
  /** The system message of each call. */
  readonly systems: Array<string | undefined>;
}

/** A gateway that returns a canned object (or runs a function) and records the prompts. */
export function fakeGateway(respond: unknown, usage = { promptTokens: 100, completionTokens: 50 }): FakeGateway {
  const prompts: string[] = [];
  const systems: Array<string | undefined> = [];
  return {
    prompts,
    systems,
    generate(prompt: string, _schema: z.ZodType, options?: AiGenerateOptions): Promise<AiGatewayResponse> {
      prompts.push(prompt);
      systems.push(options?.system);
      const object = typeof respond === 'function' ? (respond as () => unknown)() : respond;
      return Promise.resolve({ object, usage, model: 'fake-model' });
    },
  };
}

const NODE_DOCKERFILE = ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n');
const HEALTHY_INDEX = ["const app = require('express')();", "app.get('/health', (req, res) => res.send('ok'));", 'app.listen(process.env.PORT || 3000);'].join('\n');

/** MongoDB by default; `DB_TYPE=postgres` switches the store to PostgreSQL. */
export const MONGO_OR_POSTGRES: FileTree = {
  Dockerfile: NODE_DOCKERFILE,
  'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4', mongoose: '^8', pg: '^8' } }),
  'src/index.js': HEALTHY_INDEX,
  'src/db.js': [
    "const type = process.env.DB_TYPE || 'mongodb';",
    "if (type === 'postgres') {",
    "  module.exports = require('./pg');",
    '} else {',
    "  module.exports = require('mongoose');",
    '}',
  ].join('\n'),
  'src/models/user.js': ["const mongoose = require('mongoose');", "module.exports = mongoose.model('User', new mongoose.Schema({ email: String }));"].join('\n'),
};

/** The production Compose file runs MongoDB and the app declares mongoose, but no code imports it. */
export const MONGO_DECLARED_ONLY: FileTree = {
  Dockerfile: NODE_DOCKERFILE,
  'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4', mongoose: '^8' } }),
  'src/index.js': HEALTHY_INDEX,
  'docker-compose.yml': ['services:', '  app:', '    build: .', '    ports:', '      - "3000:3000"', '  mongodb:', '    image: mongo:7', ''].join('\n'),
};

/**
 * An Elixir release with a required PostgreSQL database. The rules tree holds
 * the Dockerfile, mix.exs and the Compose file; the boot code and the runtime
 * configuration (`ELIXIR_SOURCES`) are only in the repository path list.
 */
export const ELIXIR_SOURCES: FileTree = {
  'lib/app/application.ex': ['defmodule App.Application do', '  use Application', '  # Runs the migrations', '  def start(_type, _args) do', '    App.ReleaseTasks.migrate()', '  end', 'end'].join('\n'),
  'config/runtime.exs': ['import Config', 'if config_env() == :prod do', '  db_url = System.fetch_env!("DB_URL")', '  db_host = System.get_env("DB_HOST")', '  config :app, App.Repo, url: db_url', '  config :app, App.Mailer, relay: System.fetch_env!("MAILER_HOST")', 'end'].join('\n'),
};

export function elixirPostgres(): FileTree {
  const tree: FileTree = {
    Dockerfile: ['FROM elixir:1.18-alpine AS build', 'COPY . .', 'RUN mix release', 'FROM alpine:3.20', 'COPY --from=build /app/_build/prod/rel/app /app', 'ENV PORT=4000', 'EXPOSE 4000', 'CMD ["/app/bin/app", "start"]'].join('\n'),
    'mix.exs': ['defmodule App.MixProject do', '  defp deps do', '    [{:ecto_sql, "~> 3.10"}, {:postgrex, "~> 0.17"}]', '  end', 'end'].join('\n'),
    'docker-compose.yml': ['services:', '  app:', '    build: .', '  db:', '    image: postgres:16'].join('\n'),
  };
  const unfetched = [...Object.keys(ELIXIR_SOURCES), 'priv/repo/migrations/20200101_init.exs', 'test/app_test.exs', 'assets/js/app.js'];
  Object.defineProperty(tree, TREE_PATHS, { value: [...Object.keys(tree), ...unfetched], enumerable: false });
  return tree;
}
