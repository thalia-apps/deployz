import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';
import { planApplicationGraph } from '../src/planner.js';

// Phase 5 — SQS (Standard) queues and scheduled jobs, detected from strong
// production evidence only (async-detection.ts). A queue is provisioned
// only when a producer AND a consumer both resolve to a declared workload
// with no ambiguity; a scheduled job only from an explicit deployment
// declaration naming both a schedule and a command. Everything weaker
// becomes a non-blocking `questions` entry — never a rejection.

const BASE: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/server.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'async-app',
    scripts: { start: 'node dist/server.js' },
    dependencies: { express: '^4.18.0', '@aws-sdk/client-sqs': '^3.600.0' },
  }),
  'src/server.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
};

function metadata(tree: FileTree) {
  return analyseRepo(tree).metadata;
}

describe('async-detection — SQS queues', () => {
  it('a clean producer (web) + consumer (worker) pair provisions the queue', () => {
    const tree: FileTree = {
      ...BASE,
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        "app.post('/orders', () => sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL })));",
      ].join('\n'),
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      ].join('\n'),
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['asyncQuestions']).toEqual([]);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.queues).toHaveLength(1);
    const queue = manifest.queues![0]!;
    expect(queue.id).toBe('orders-queue');
    expect(queue.producers).toEqual(['web']);
    expect(queue.consumers).toEqual(['worker']);

    const graph = manifestToApplicationGraph(manifest);
    const bindings = graph.bindings.map((b) => [b.sourceId, b.targetId, b.access]);
    expect(bindings).toContainEqual(['web', 'orders-queue', 'produce']);
    expect(bindings).toContainEqual(['worker', 'orders-queue', 'consume']);

    const ir = planApplicationGraph({ graph, region: null });
    expect(ir.resources.find((r) => r.componentId === 'orders-queue')?.capabilityKey).toBe('aws.sqs');
  });

  it('a queue naming a workload the final manifest lacks, or a colliding id, becomes a question', () => {
    const tree: FileTree = {
      ...BASE,
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        "app.post('/x', () => sqs.send(new SendMessageCommand({ QueueUrl: process.env.CACHE_URL_QUEUE_URL })));",
      ].join('\n'),
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/worker.ts': 'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.CACHE_URL_QUEUE_URL }));\n',
    };
    const analysis = analyseRepo(tree);
    const queue = (analysis.metadata['asyncQueues'] as { id: string; consumers: string[] }[])[0]!;

    // A consumer the manifest does not declare (e.g. a vendor override
    // replaced the worker list) is never handed to the planner.
    const ghost = { ...analysis, metadata: { ...analysis.metadata, asyncQueues: [{ ...queue, consumers: ['ghost'] }] } };
    const ghostManifest = normalizeDeploymentManifest(ghost, {});
    expect(ghostManifest.queues).toBeUndefined();
    expect(ghostManifest.questions?.map((q) => q.field)).toContain('queue_relationship');

    // A queue id that collides with a fixed component id is never provisioned.
    const clash = { ...analysis, metadata: { ...analysis.metadata, asyncQueues: [{ ...queue, id: 'storage' }] } };
    const clashManifest = normalizeDeploymentManifest(clash, {});
    expect(clashManifest.queues).toBeUndefined();
    expect(() => planApplicationGraph({ graph: manifestToApplicationGraph(clashManifest), region: null })).not.toThrow();
  });

  it('producer and consumer both inside worker processes', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nproducer-worker: node dist/producer.js\nconsumer-worker: node dist/consumer.js\n',
      'src/producer.ts': [
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.JOBS_QUEUE_URL }));',
      ].join('\n'),
      'src/consumer.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.JOBS_QUEUE_URL }));',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.queues).toHaveLength(1);
    expect(manifest.queues![0]!.producers).toEqual(['producer-worker']);
    expect(manifest.queues![0]!.consumers).toEqual(['consumer-worker']);
  });

  it('multiple queues resolve independently', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.EMAILS_QUEUE_URL }));',
      ].join('\n'),
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.EMAILS_QUEUE_URL }));',
      ].join('\n'),
    };
    // Two vars in one file each -> ambiguous per file, but each is the ONLY
    // var in its own file below, so split across two files instead.
    tree['src/server.ts'] = [
      "import express from 'express';",
      "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      "app.post('/orders', () => sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL })));",
      'app.listen(process.env.PORT ?? 3000);',
    ].join('\n');
    tree['src/emails.ts'] = [
      "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
      'sqs.send(new SendMessageCommand({ QueueUrl: process.env.EMAILS_QUEUE_URL }));',
    ].join('\n');
    tree['src/server.ts'] += "\nimport './emails';\n";
    tree['src/worker.ts'] = [
      "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
      'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
    ].join('\n');
    tree['src/worker-emails.ts'] = [
      "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
      'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.EMAILS_QUEUE_URL }));',
    ].join('\n');
    tree['src/worker.ts'] += "\nimport './worker-emails';\n";

    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    const ids = manifest.queues!.map((q) => q.id).sort();
    expect(ids).toEqual(['emails-queue', 'orders-queue']);
  });

  it('a queue plus its dead-letter queue', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      ].join('\n'),
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
        "import './dlq';",
      ].join('\n'),
      'src/dlq.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_DLQ_URL }));',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    const queue = manifest.queues!.find((q) => q.id === 'orders-queue')!;
    expect(queue.deadLetter).toBeDefined();
    expect(queue.deadLetter!.maxReceiveCount).toBe(5);
    expect(queue.deadLetter!.consumers).toEqual(['worker']);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.resources.map((r) => r.id)).toContain('orders-queue-dlq');
  });

  it('an SQS SDK dependency with no operations creates nothing and asks nothing', () => {
    const meta = metadata(BASE);
    expect(meta['asyncQueues']).toEqual([]);
    expect(meta['asyncQuestions']).toEqual([]);
  });

  it('a producer with no consumer becomes a question, not a queue', () => {
    const tree: FileTree = {
      ...BASE,
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      ].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncQueues']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a consumer with no producer becomes a question, not a queue', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      ].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncQueues']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a consumer loop only reachable from the web process is never trusted', () => {
    const tree: FileTree = {
      ...BASE,
      'src/server.ts': [
        ...BASE['src/server.ts']!.split('\n'),
        "import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.queues ?? []).toEqual([]);
    expect((manifest.questions ?? []).length).toBeGreaterThan(0);
  });

  it('a file reading two queue vars with SQS ops is ambiguous', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'const a = process.env.ORDERS_QUEUE_URL;',
        'const b = process.env.EMAILS_QUEUE_URL;',
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: a }));',
      ].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncQueues']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('Python boto3 SQS usage is a question, never a rejection', () => {
    const tree: FileTree = {
      'Dockerfile': BASE['Dockerfile']!,
      'requirements.txt': 'boto3==1.34.0\nflask==3.0.0\n',
      'app.py': 'import boto3\nsqs = boto3.client("sqs")\nsqs.receive_message(QueueUrl="x")\n',
    };
    const analysis = analyseRepo(tree);
    expect(analysis.rejections.find((r) => r.dependency === 'sqs-event-consumer')).toBeUndefined();
    expect((analysis.metadata['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('BullMQ/Redis queues never produce SQS infrastructure', () => {
    const tree: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({
        name: 'async-app',
        scripts: { start: 'node dist/server.js' },
        dependencies: { express: '^4.18.0', bullmq: '^5.0.0' },
      }),
    };
    const meta = metadata(tree);
    expect(meta['asyncQueues']).toEqual([]);
    expect(meta['asyncQuestions']).toEqual([]);
  });

  it('Kafka and RabbitMQ keep their existing rejection and create no queue', () => {
    const kafka: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({ dependencies: { kafkajs: '^2.2.0' } }),
      'src/consumer.js': "const brokers = process.env.KAFKA_BROKERS.split(',');\n",
    };
    const kafkaAnalysis = analyseRepo(kafka);
    expect(kafkaAnalysis.rejections.find((r) => r.dependency === 'kafka')?.detected).toBe(true);
    expect(kafkaAnalysis.metadata['asyncQueues']).toEqual([]);

    const rabbit: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({ dependencies: { amqplib: '^0.10.0' } }),
      'src/queue.js': 'const connection = await amqp.connect(process.env.AMQP_URL);\n',
    };
    const rabbitAnalysis = analyseRepo(rabbit);
    expect(rabbitAnalysis.rejections.find((r) => r.dependency === 'rabbitmq')?.detected).toBe(true);
    expect(rabbitAnalysis.metadata['asyncQueues']).toEqual([]);
  });
});

describe('async-detection — scheduled jobs', () => {
  it('a render.yaml cron service provisions a scheduled job', () => {
    const tree: FileTree = {
      ...BASE,
      'render.yaml': [
        'services:',
        '  - type: cron',
        '    name: cleanup',
        '    schedule: "0 3 * * *"',
        '    startCommand: node dist/cleanup.js',
        '',
      ].join('\n'),
      'src/cleanup.ts': 'console.log("cleanup");\n',
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.scheduledJobs).toHaveLength(1);
    const job = manifest.scheduledJobs![0]!;
    expect(job.id).toBe('cleanup');
    expect(job.command).toBe('node dist/cleanup.js');
    expect(job.schedule).toEqual({ type: 'cron', cron: '0 3 * * *' });
    expect(job.timezone).toBeNull();

    const graph = manifestToApplicationGraph(manifest);
    const schedule = graph.schedules?.find((s) => s.id === 'cleanup-schedule');
    expect(schedule).toBeDefined();
    const ir = planApplicationGraph({ graph, region: null });
    expect(ir.schedules?.[0]?.targetWorkloadId).toBe('cleanup');
  });

  it('a Kubernetes CronJob with a timezone and suspend', () => {
    const tree: FileTree = {
      ...BASE,
      'k8s/cleanup-cronjob.yaml': [
        'apiVersion: batch/v1',
        'kind: CronJob',
        'metadata:',
        '  name: cleanup',
        'spec:',
        '  schedule: "0 3 * * *"',
        '  timeZone: "Europe/Berlin"',
        '  suspend: true',
        '  jobTemplate:',
        '    spec:',
        '      template:',
        '        spec:',
        '          containers:',
        '            - name: cleanup',
        '              command: ["node"]',
        '              args: ["dist/cleanup.js"]',
        '',
      ].join('\n'),
      'src/cleanup.ts': 'console.log("cleanup");\n',
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    const job = manifest.scheduledJobs!.find((j) => j.id === 'cleanup')!;
    expect(job.timezone).toBe('Europe/Berlin');
    expect(job.command).toBe('node dist/cleanup.js');
    expect(job.enabled).toBe(false);
  });

  it('a scheduled job that produces to a queue participates as a workload', () => {
    const tree: FileTree = {
      ...BASE,
      'Procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'render.yaml': [
        'services:',
        '  - type: cron',
        '    name: nightly',
        '    schedule: "0 2 * * *"',
        '    startCommand: node dist/nightly.js',
        '',
      ].join('\n'),
      'src/nightly.ts': [
        "import { SendMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new SendMessageCommand({ QueueUrl: process.env.REPORTS_QUEUE_URL }));',
      ].join('\n'),
      'src/worker.ts': [
        "import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.REPORTS_QUEUE_URL }));',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    const queue = manifest.queues!.find((q) => q.id === 'reports-queue')!;
    expect(queue.producers).toEqual(['nightly']);
    expect(queue.consumers).toEqual(['worker']);
  });

  it('in-process cron (node-cron, @nestjs/schedule) never provisions or asks', () => {
    const tree: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({
        name: 'async-app',
        scripts: { start: 'node dist/server.js' },
        dependencies: { express: '^4.18.0', 'node-cron': '^3.0.0', '@nestjs/schedule': '^4.0.0' },
      }),
      'src/jobs.ts': [
        "import cron from 'node-cron';",
        "cron.schedule('0 3 * * *', () => console.log('run'));",
      ].join('\n'),
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['asyncScheduledJobs']).toEqual([]);
    expect(analysis.metadata['asyncQuestions']).toEqual([]);
    expect(analysis.metadata['hasWorkerProcesses']).toBe(false);
  });

  it('GitHub Actions `on: schedule` is CI, not production — nothing', () => {
    const tree: FileTree = {
      ...BASE,
      '.github/workflows/nightly.yml': ['on:', '  schedule:', "    - cron: '0 3 * * *'", ''].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncScheduledJobs']).toEqual([]);
    expect(meta['asyncQuestions']).toEqual([]);
  });

  it('vercel.json crons (an HTTP path, no command) is a question', () => {
    const tree: FileTree = {
      ...BASE,
      'vercel.json': JSON.stringify({ crons: [{ path: '/api/cron', schedule: '0 3 * * *' }] }),
    };
    const meta = metadata(tree);
    expect(meta['asyncScheduledJobs']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a crontab file with no deployment declaration is a question', () => {
    const tree: FileTree = { ...BASE, crontab: '0 3 * * * /app/cleanup.sh\n' };
    const meta = metadata(tree);
    expect(meta['asyncScheduledJobs']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('an invalid cron expression in render.yaml is a question, never provisioned', () => {
    const tree: FileTree = {
      ...BASE,
      'render.yaml': [
        'services:',
        '  - type: cron',
        '    name: cleanup',
        '    schedule: "not a cron"',
        '    startCommand: node dist/cleanup.js',
        '',
      ].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncScheduledJobs']).toEqual([]);
    expect((meta['asyncQuestions'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a CronJob manifest under a docs/examples path is ignored', () => {
    const tree: FileTree = {
      ...BASE,
      'docs/examples/cronjob.yaml': [
        'apiVersion: batch/v1',
        'kind: CronJob',
        'metadata:',
        '  name: example',
        'spec:',
        '  schedule: "0 3 * * *"',
        '  jobTemplate:',
        '    spec:',
        '      template:',
        '        spec:',
        '          containers:',
        '            - name: example',
        '              command: ["node"]',
        '              args: ["dist/example.js"]',
        '',
      ].join('\n'),
    };
    const meta = metadata(tree);
    expect(meta['asyncScheduledJobs']).toEqual([]);
    expect(meta['asyncQuestions']).toEqual([]);
  });
});
