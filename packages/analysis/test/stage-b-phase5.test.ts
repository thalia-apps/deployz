import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { detectHealthEndpoint } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

function healthPath(tree: FileTree): string | undefined {
  return detectHealthEndpoint(tree).path;
}

function analyseHealth(tree: FileTree) {
  const analysis = analyseRepo(tree);
  const finding = analysis.findings.find((f) => f.detector === 'health-endpoint');
  return {
    finding,
    metaMode: analysis.metadata['healthMode'],
    metaPath: analysis.metadata['healthPath'],
  };
}

const NODE_APP: FileTree = {
  'package.json': JSON.stringify({
    name: 'app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0' },
  }),
  'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/health', (_q, r) => r.json({}));\napp.listen(3000);\n",
  'Dockerfile': 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
};

// ==========================================================================
// Framework route declarations (COMP-005)
// ==========================================================================

describe('health-path detection across frameworks (COMP-005)', () => {
  it('NestJS: @Controller(health) with an empty @Get under the literal global prefix (A1-003)', () => {
    const tree: FileTree = {
      'apps/server/src/main.ts': "const app = await NestFactory.create(AppModule);\napp.setGlobalPrefix('api', { exclude: ['robots.txt'] });\n",
      'apps/server/src/integrations/health/health.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('health')",
        'export class HealthController {',
        '  @Get()',
        '  async check() { return {}; }',
        '}',
        '',
      ].join('\n'),
    };
    expect(healthPath(tree)).toBe('/api/health');
  });

  it('NestJS: a health controller without a global prefix is served at its own path', () => {
    const tree: FileTree = {
      'src/health.controller.ts': "@Controller({ path: 'health' })\nexport class H {\n  @Get()\n  ok() {}\n}\n",
    };
    expect(healthPath(tree)).toBe('/health');
  });

  it('NestJS: a non-health controller is not a health route', () => {
    const tree: FileTree = {
      'src/users.controller.ts': "@Controller('users')\nexport class U {\n  @Get()\n  list() {}\n}\n",
    };
    expect(healthPath(tree)).toBeUndefined();
  });

  it('Java/Spring: @GetMapping literal + actuator with context path', () => {
    const tree: FileTree = {
      'pom.xml': '  <artifactId>spring-boot-starter-web</artifactId>\n  <artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/java/com/app/HealthController.java': [
        'package com.app;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        'public class HealthController {',
        '  @GetMapping("/api/v1/health")',
        '  public String health() { return "ok"; }',
        '}',
        '',
      ].join('\n'),
      'src/main/resources/application.properties': 'server.servlet.context-path=/app\n',
    };
    expect(healthPath(tree)).toBe('/api/v1/health');
  });

  it('Java/Spring: actuator health is used when no exclusion is configured, prefixed by context-path', () => {
    const tree: FileTree = {
      'pom.xml': '<artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/java/com/app/App.java': 'public class App {}\n',
      'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /svc\n',
    };
    expect(healthPath(tree)).toBe('/svc/actuator/health');
  });

  it('Java/Spring: actuator is not used when exposure excludes health', () => {
    const tree: FileTree = {
      'pom.xml': '<artifactId>spring-boot-starter-actuator</artifactId>\n',
      'src/main/resources/application.properties': 'management.endpoints.web.exposure.include=info,metrics\n',
      'src/main/java/com/app/App.java': 'public class App {}\n',
    };
    expect(analyseHealth(tree).metaMode).toBe('root');
  });

  it('Rails: get "/up" in config/routes.rb', () => {
    const tree: FileTree = { 'config/routes.rb': "Rails.application.routes.draw do\n  get '/up', to: 'rails/health#show'\nend\n" };
    expect(healthPath(tree)).toBe('/up');
  });

  it('Python Django: urls.py path("health/", ...)', () => {
    const tree: FileTree = { 'config/urls.py': "urlpatterns = [ path('api/v1/health/', include('health.urls')), ]\n" };
    expect(healthPath(tree)).toBe('/api/v1/health');
  });

  it('Python Flask: @app.route("/healthz")', () => {
    const tree: FileTree = { 'app.py': "@app.route('/healthz')\ndef health(): return 'ok'\n" };
    expect(healthPath(tree)).toBe('/healthz');
  });

  it('Go: http.HandleFunc("GET /healthz") and gin GET /api/ping', () => {
    const tree: FileTree = {
      'main.go': 'http.HandleFunc("GET /healthz", h)\n',
      'api/server.go': 'r.GET("/api/ping", h)\n',
    };
    expect(healthPath(tree)).toBe('/api/ping');
  });

  it('PHP Laravel: routes/api.php health route is served under /api', () => {
    const tree: FileTree = { 'routes/api.php': "Route::get('/up', fn () => 'ok');\n" };
    expect(healthPath(tree)).toBe('/api/up');
  });

  it('.NET: MapGet("/health", ...)', () => {
    const tree: FileTree = { 'Program.cs': 'app.MapGet("/health", () => "ok");\n' };
    expect(healthPath(tree)).toBe('/health');
  });

  it('Phoenix: get "/health" inside scope "/api"', () => {
    const tree: FileTree = {
      'lib/app_web/router.ex': [
        'scope "/api", AppWeb do',
        '  get "/health", HealthController, :show',
        'end',
        '',
      ].join('\n'),
    };
    expect(healthPath(tree)).toBe('/api/health');
  });

  it('Express: a /health/live route registered before /health/ready keeps the full first path, not a truncated /health', () => {
    const tree: FileTree = {
      'src/index.ts': [
        "import express from 'express';",
        'const app = express();',
        "app.get('/health/live', (_req, res) => res.json({ ok: true }));",
        "app.get('/health/ready', (_req, res) => res.json({ ok: true }));",
        'app.listen(3000);',
      ].join('\n'),
    };
    // HEALTH_ROUTE_REGEX.exec() (no /g flag) returns only the FIRST match in
    // the file, so the first registered route — /health/live — wins.
    expect(healthPath(tree)).toBe('/health/live');
  });

  it("a bare '/health' route literal still matches in full (no over-truncation regression)", () => {
    const tree: FileTree = {
      'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\n",
    };
    expect(healthPath(tree)).toBe('/health');
  });

  it("a bare '/healthz' route literal still matches in full", () => {
    const tree: FileTree = {
      'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/healthz', (_req, res) => res.json({ ok: true }));\n",
    };
    expect(healthPath(tree)).toBe('/healthz');
  });
});

// ==========================================================================
// Health modes + manifest/gate behaviour
// ==========================================================================

describe('health modes (Stage B phase 5)', () => {
  it('a HEALTHCHECK URL becomes the path (explicit)', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20\nHEALTHCHECK CMD curl -f http://localhost:3000/api/heartbeat || exit 1\nCMD ["node", "index.js"]\n',
    };
    expect(healthPath(tree)).toBe('/api/heartbeat');
    expect(analyseHealth(tree).metaMode).toBe('explicit');
  });

  it('a HEALTHCHECK that probes / is ROOT mode', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM node:20\nHEALTHCHECK CMD curl -f http://localhost:3000/ || exit 1\nCMD ["node", "index.js"]\n',
    };
    const health = analyseHealth(tree);
    expect(health.finding?.path).toBe('/');
    expect(health.metaMode).toBe('root');
  });

  it('no health evidence anywhere probes / and also accepts a redirect', () => {
    const tree: FileTree = {
      ...NODE_APP,
      'src/index.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
    };
    expect(analyseHealth(tree)).toMatchObject({ metaMode: 'root', metaPath: '/' });

    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.health).toEqual({ path: '/', mode: 'root', redirectsAccepted: true });
    expect(evaluateManifestReadiness(manifest).findings.some((f) => f.id === 'health-path-required')).toBe(false);
    // A path the vendor enters must answer 200.
    expect(normalizeDeploymentManifest(analyseRepo(tree), { healthPath: '/status' }).health).toEqual({ path: '/status', mode: 'explicit' });
  });

  it.each(['src/Action/HealthAction.php', 'lib/app_web/health_check.ex', 'Controllers/GreenfieldHealthController.cs'])(
    'an unresolved health handler (%s) is vendor_required and blocks the deployment gate',
    (handler) => {
      const tree: FileTree = {
        ...NODE_APP,
        'src/index.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
        [handler]: '',
      };
      expect(analyseHealth(tree)).toMatchObject({ metaMode: 'vendor_required', metaPath: null });
      const result = evaluateManifestReadiness(normalizeDeploymentManifest(analyseRepo(tree), {}));
      expect(result.state).toBe('NEEDS_CONFIGURATION');
      expect(result.findings.some((f) => f.id === 'health-path-required')).toBe(true);
    },
  );

  it('a dependency health check (RedisHealthCheck.cs) is not a health handler', () => {
    const tree: FileTree = { ...NODE_APP, 'src/index.ts': 'app.listen(3000);\n', 'src/HealthChecks/RedisHealthCheck.cs': '' };
    expect(analyseHealth(tree).metaMode).toBe('root');
  });

  it('existing JS route evidence still resolves explicit and the gate passes', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(NODE_APP), {});
    expect(manifest.health).toMatchObject({ path: '/health', mode: 'explicit' });
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });
});
