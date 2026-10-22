import { describe, expect, it } from 'vitest';

import { postgresSemantic } from '../src/bindings.js';
import { detectEnvVarModel, detectHealthEndpoint, isRuntimeSourcePath, type FileTree } from '../src/detectors.js';

function modelByKey(tree: FileTree) {
  return new Map(detectEnvVarModel(tree).map((entry) => [entry.key, entry]));
}

describe('env reads in C#, Java, PHP, Rust and Elixir', () => {
  it('C#: an environment read is required behind ?? throw or !, optional with ?? default', () => {
    const byKey = modelByKey({
      'src/Api/Program.cs': [
        'var key = Environment.GetEnvironmentVariable("SIGNING_KEY") ?? throw new InvalidOperationException("SIGNING_KEY");',
        'var token = Environment.GetEnvironmentVariable("API_TOKEN")!;',
        'var mode = Environment.GetEnvironmentVariable("APP_MODE") ?? "web";',
        'var jwt = builder.Configuration["Jwt:Secret"] ?? throw new Exception("jwt");',
        'var conn = builder.Configuration.GetConnectionString("Default") ?? throw new Exception("db");',
        'var size = configuration.GetValue<int>("Upload:MaxSize", 10);',
        'var dataDir = configuration["datadir"];',
      ].join('\n'),
    });
    expect(byKey.get('SIGNING_KEY')).toMatchObject({ required: true });
    expect(byKey.get('API_TOKEN')).toMatchObject({ required: true });
    expect(byKey.get('APP_MODE')).toMatchObject({ required: false });
    expect(byKey.get('Jwt__Secret')).toMatchObject({ required: true });
    expect(byKey.get('ConnectionStrings__Default')).toMatchObject({ required: true });
    expect(byKey.get('Upload__MaxSize')).toMatchObject({ required: false });
    expect(byKey.has('datadir')).toBe(false);
  });

  it('C#: an appsettings.json value is the default of the variable that overrides it', () => {
    const byKey = modelByKey({
      'src/Api/Program.cs': 'var conn = builder.Configuration.GetConnectionString("Default") ?? throw new Exception("db");',
      'src/Api/appsettings.json': '{\n  // local database\n  "ConnectionStrings": { "Default": "Host=localhost" }\n}',
    });
    expect(byKey.get('ConnectionStrings__Default')).toMatchObject({ required: false });
  });

  it('C#: a read in a test project is not production code', () => {
    const tree = { 'BTCPayServer.Tests/ServerTester.cs': 'var x = Environment.GetEnvironmentVariable("TESTS_POSTGRES") ?? throw new Exception();' };
    expect(isRuntimeSourcePath('BTCPayServer.Tests/ServerTester.cs')).toBe(false);
    expect(isRuntimeSourcePath('test/OrchardCore.Tests.Functional/x.cs')).toBe(false);
    expect(modelByKey(tree).has('TESTS_POSTGRES')).toBe(false);
  });

  it('Java: @Value without a default is required, with a default optional; System.getenv stays optional', () => {
    const byKey = modelByKey({
      'src/main/java/app/Config.java': [
        '@Value("${MAIL_API_KEY}") String mailKey;',
        '@Value("${PAGE_SIZE:20}") int pageSize;',
        'String dbHost = Objects.requireNonNull(System.getenv("OPENSHIFT_DB_HOST"), "missing");',
      ].join('\n'),
      'src/test/java/app/ConfigTest.java': '@Value("${TEST_ONLY_KEY}") String key;',
    });
    expect(byKey.get('MAIL_API_KEY')).toMatchObject({ required: true });
    expect(byKey.get('PAGE_SIZE')).toMatchObject({ required: false });
    expect(byKey.get('OPENSHIFT_DB_HOST')).toMatchObject({ required: false });
    expect(byKey.has('TEST_ONLY_KEY')).toBe(false);
  });

  it('Spring: a dev or test profile file does not count', () => {
    const byKey = modelByKey({
      'src/main/resources/application.properties': 'app.key=${APP_SECRET_KEY:changeme}',
      'src/main/resources/application-dev.properties': 'app.token=${DEV_API_TOKEN}',
    });
    expect(byKey.get('APP_SECRET_KEY')).toMatchObject({ required: false });
    expect(byKey.has('DEV_API_TOKEN')).toBe(false);
  });

  it('Spring: a datasource that pins an embedded driver gets no SPRING_DATASOURCE_* binding names', () => {
    const embedded = modelByKey({
      'src/main/resources/application.yaml': 'spring:\n  datasource:\n    url: jdbc:h2:mem:test_mem\n    driver-class-name: org.h2.Driver\n',
    });
    const postgres = modelByKey({
      'src/main/resources/application.yaml': 'spring:\n  datasource:\n    url: jdbc:postgresql://localhost/app\n',
    });
    expect(embedded.has('SPRING_DATASOURCE_URL')).toBe(false);
    expect(postgres.has('SPRING_DATASOURCE_URL')).toBe(true);
  });

  it('PHP: getenv, $_ENV, $_SERVER and env() are optional unless a throw guards them; server names are not variables', () => {
    const byKey = modelByKey({
      'app/constants.php': [
        "define('DATA_DIR', getenv('DATA_DIR') ?: '/data');",
        "$key = $_ENV['APP_KEY'] ?? throw new RuntimeException('APP_KEY');",
        "$host = $_SERVER['HTTP_HOST'];",
        "$region = $_SERVER['APP_REGION'];",
        "$debug = env('APP_DEBUG');",
        "// $old = getenv('OLD_SETTING');",
      ].join('\n'),
      'tests/bootstrap.php': "$db = getenv('TEST_DB') ?: throw new Exception();",
    });
    expect(byKey.get('DATA_DIR')).toMatchObject({ required: false });
    expect(byKey.get('APP_KEY')).toMatchObject({ required: true });
    expect(byKey.get('APP_REGION')).toMatchObject({ required: false });
    expect(byKey.get('APP_DEBUG')).toMatchObject({ required: false });
    expect(byKey.has('HTTP_HOST')).toBe(false);
    expect(byKey.has('OLD_SETTING')).toBe(false);
    expect(byKey.has('TEST_DB')).toBe(false);
  });

  it('Symfony: %env(X)% is required for a secret unless a default exists', () => {
    const byKey = modelByKey({
      'config/services.yaml': [
        'parameters:',
        "    env(MAILER_DSN_SECRET): 'null://null'",
        'services:',
        "    app.signer: { arguments: ['%env(APP_SIGNING_SECRET)%', '%env(MAILER_DSN_SECRET)%', '%env(default:fallback:WEBHOOK_TOKEN)%', '%env(MAILER_FROM)%'] }",
      ].join('\n'),
    });
    expect(byKey.get('APP_SIGNING_SECRET')).toMatchObject({ required: true });
    expect(byKey.get('MAILER_DSN_SECRET')).toMatchObject({ required: false });
    expect(byKey.get('WEBHOOK_TOKEN')).toMatchObject({ required: false });
    expect(byKey.get('MAILER_FROM')).toMatchObject({ required: false });
  });

  it('Rust: env::var with expect, unwrap or ? is required, unwrap_or optional; env! and tests do not count', () => {
    const byKey = modelByKey({
      'src/main.rs': [
        'let key = std::env::var("SESSION_KEY").expect("SESSION_KEY must be set");',
        'let url = env::var("UPSTREAM_URL")?;',
        'let level = env::var("LOG_LEVEL").unwrap_or("info".into());',
        'let proxy = env::var_os("HTTP_PROXY").is_some();',
        'const VERSION: &str = env!("CARGO_PKG_VERSION");',
        '#[cfg(test)]',
        'mod tests { fn t() { env::var("TEST_TOKEN").unwrap(); } }',
      ].join('\n'),
      'build.rs': 'let v = env::var("BUILD_VERSION").unwrap();',
      'benches/load.rs': 'let v = env::var("BENCH_TARGET").unwrap();',
    });
    expect(byKey.get('SESSION_KEY')).toMatchObject({ required: true });
    expect(byKey.get('UPSTREAM_URL')).toMatchObject({ required: true });
    expect(byKey.get('LOG_LEVEL')).toMatchObject({ required: false });
    expect(byKey.get('HTTP_PROXY')).toMatchObject({ required: false });
    for (const key of ['CARGO_PKG_VERSION', 'TEST_TOKEN', 'BUILD_VERSION', 'BENCH_TARGET']) expect(byKey.has(key)).toBe(false);
  });

  it('Elixir: fetch_env! and get_env || raise in config are required, unless a branch or a dev config holds them', () => {
    const byKey = modelByKey({
      'config/runtime.exs': [
        'if config_env() == :prod do',
        '  secret = System.fetch_env!("SIGNING_SECRET")',
        '  database_url =',
        '    System.get_env("APP_DATABASE_URL") ||',
        '      raise "APP_DATABASE_URL is missing"',
        '  config :app, Repo, username: Util.fetch_env!("REPO_USER", all: "postgres")',
        '  config :app, pool: System.get_env("POOL_SIZE", "10")',
        '  case System.get_env("MAILER_TYPE") || "smtp" do',
        '    "smtp" ->',
        '      host = System.fetch_env!("SMTP_HOST")',
        '  end',
        '  password = if auth != :none, do: System.fetch_env!("SMTP_PASSWORD")',
        'end',
      ].join('\n'),
      'config/dev.exs': 'config :app, key: System.fetch_env!("DEV_ONLY_KEY")',
      'lib/app/s3.ex': 'def bucket, do: System.fetch_env!("EXPORTS_BUCKET")',
    });
    expect(byKey.get('SIGNING_SECRET')).toMatchObject({ required: true });
    expect(byKey.get('APP_DATABASE_URL')).toMatchObject({ required: true });
    expect(byKey.get('REPO_USER')).toMatchObject({ required: true });
    expect(byKey.get('POOL_SIZE')).toMatchObject({ required: false });
    expect(byKey.get('SMTP_HOST')).toMatchObject({ required: false });
    expect(byKey.get('SMTP_PASSWORD')).toMatchObject({ required: false });
    expect(byKey.get('EXPORTS_BUCKET')).toMatchObject({ required: false });
    expect(byKey.has('DEV_ONLY_KEY')).toBe(false);
  });

  it('a Deployz database name binds, a Docker-link or OpenShift name does not', () => {
    expect(postgresSemantic('DATABASE_PASS')).toBe('password');
    expect(postgresSemantic('POSTGRES_ENV_POSTGRES_DB')).toBeNull();
    expect(postgresSemantic('OPENSHIFT_POSTGRESQL_DB_HOST')).toBeNull();
  });
});

describe('health routes under a prefix', () => {
  it('Spring: a class-level @RequestMapping(value = "/api") prefixes the route', () => {
    const finding = detectHealthEndpoint({
      'src/main/java/app/ApiController.java': '@RestController\n@RequestMapping(value = "/api", produces = "application/json")\npublic class ApiController {\n  @GetMapping("/ping")\n  public String ping() { return "pong"; }\n}',
    });
    expect(finding.path).toBe('/api/ping');
  });

  it('Phoenix: a route takes the path of its enclosing scope', () => {
    const finding = detectHealthEndpoint({
      'lib/app_web/router.ex': [
        'scope "/", AppWeb do',
        '  get "/", PageController, :index',
        'end',
        '',
        'scope "/api", AppWeb do',
        '  scope [] do',
        '    get "/health", Api.SystemController, :readiness',
        '  end',
        'end',
      ].join('\n'),
    });
    expect(finding.path).toBe('/api/health');
  });
});
