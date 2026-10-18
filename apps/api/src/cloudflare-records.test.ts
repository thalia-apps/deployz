import { describe, expect, it } from 'vitest';

import {
  CloudflareDnsError,
  CLOUDFLARE_RECORD_COMMENT,
  CLOUDFLARE_VALIDATION_RECORD_COMMENT,
  createCloudflareDnsClient,
  createFakeCloudflareDnsClient,
  type CloudflareDnsRecord,
  type CloudflareFetchFn,
} from './cloudflare-records.js';

// Phase 3 — the control plane's Cloudflare DNS surface. Pure unit tests: the
// transport is always injected and every scenario runs against fake
// Responses, so no request ever reaches api.cloudflare.com (this file does
// not even mention the production base URL).

const ZONE_ID = 'zone-test-1';
const ZONE_NAME = 'deployz.dev';
const TOKEN = 'test-secret-token';
const API_BASE_URL = 'https://cloudflare.test';
const TARGET = 'alb.example.com';
const HOSTNAME = 'd-dep-1.deployz.dev';
const VALIDATION_NAME = `_abc123.${HOSTNAME}`;
const VALIDATION_VALUE = '_v.acm-validations.aws.';

function record(
  id: string,
  content: string,
  overrides: Partial<CloudflareDnsRecord> = {},
): CloudflareDnsRecord {
  return {
    id,
    type: 'CNAME',
    name: HOSTNAME,
    content,
    ttl: 1,
    proxied: true,
    comment: CLOUDFLARE_RECORD_COMMENT,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function okList(...records: CloudflareDnsRecord[]): Response {
  return jsonResponse(200, {
    success: true,
    result: records,
    errors: [],
    messages: [],
    result_info: { count: records.length },
  });
}

function okResult(recordResult: CloudflareDnsRecord): Response {
  return jsonResponse(200, { success: true, result: recordResult, errors: [], messages: [] });
}

function errResponse(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { success: false, errors: [{ code, message }], messages: [] }, headers);
}

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function makeClient(
  handle: (url: string, init: RequestInit) => Response | Promise<Response>,
  prefix?: string,
): { client: ReturnType<typeof createCloudflareDnsClient>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: CloudflareFetchFn = async (url, init) => {
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return handle(url, init);
  };
  const client = createCloudflareDnsClient({
    token: TOKEN,
    zoneId: ZONE_ID,
    zoneName: ZONE_NAME,
    apiBaseUrl: API_BASE_URL,
    fetchFn,
    ...(prefix === undefined ? {} : { prefix }),
  });
  return { client, calls };
}

async function failure(promise: Promise<unknown>): Promise<CloudflareDnsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareDnsError);
    return error as CloudflareDnsError;
  }
  throw new Error('expected the call to throw a CloudflareDnsError');
}

describe('createCloudflareDnsClient — upsert idempotency', () => {
  it('missing → POSTs a proxied CNAME with the Bearer token and zone path', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      if (init.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return okResult(record('rec-new', body['content'] as string));
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result.op).toBe('created');
    expect(result.record?.content).toBe(TARGET);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(
      `${API_BASE_URL}/zones/${ZONE_ID}/dns_records?type=CNAME&name.exact=${HOSTNAME}`,
    );
    const post = calls[1]!;
    expect(post.method).toBe('POST');
    expect(post.url).toBe(`${API_BASE_URL}/zones/${ZONE_ID}/dns_records`);
    expect(post.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(post.body!)).toEqual({
      type: 'CNAME',
      name: HOSTNAME,
      content: TARGET,
      ttl: 1,
      proxied: true,
      comment: CLOUDFLARE_RECORD_COMMENT,
    });
  });

  it('identical record → noop (transport sees the list call only)', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(record('rec-1', TARGET));
      throw new Error(`unexpected ${init.method} on an identical record`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result).toEqual({ op: 'noop', record: record('rec-1', TARGET) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
  });

  it('drifting target → PUT to the record id with the new content', async () => {
    const seenBodies: string[] = [];
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(record('rec-1', 'old-alb.example.com'));
      if (init.method === 'PUT') {
        seenBodies.push(init.body as string);
        return okResult(record('rec-1', TARGET));
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result.op).toBe('updated');
    expect(calls).toHaveLength(2);
    const put = calls[1]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`${API_BASE_URL}/zones/${ZONE_ID}/dns_records/rec-1`);
    expect(JSON.parse(seenBodies[0]!)).toMatchObject({ name: HOSTNAME, content: TARGET, proxied: true });
  });

  it('an unproxied record with the right content → PUT to restore proxying', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(record('rec-1', TARGET, { proxied: false }));
      if (init.method === 'PUT') return okResult(record('rec-1', TARGET));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result.op).toBe('updated');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
  });

  it('returns the first exact-name match when Cloudflare lists several', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') {
        return okList(
          record('rec-first', TARGET),
          { ...record('rec-second', TARGET), id: 'rec-second' },
        );
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const found = await client.getRecord('dep-1');

    expect(found?.id).toBe('rec-first');
    expect(calls).toHaveLength(1);
  });
});

describe('createCloudflareDnsClient — delete', () => {
  it('existing → DELETE by record id', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(record('rec-1', TARGET));
      if (init.method === 'DELETE') return okResult(record('rec-1', TARGET));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.deleteDefaultDeploymentRecord('dep-1');

    expect(result).toEqual({ op: 'deleted' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1]!.url).toBe(`${API_BASE_URL}/zones/${ZONE_ID}/dns_records/rec-1`);
  });

  it('missing → noop without calling DELETE', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.deleteDefaultDeploymentRecord('dep-1');

    expect(result).toEqual({ op: 'noop' });
    expect(calls).toHaveLength(1);
  });

  it('a DELETE answered with 81044 (record does not exist) → noop', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(record('rec-1', TARGET));
      if (init.method === 'DELETE') return errResponse(400, 81044, 'Record does not exist.');
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.deleteDefaultDeploymentRecord('dep-1');

    expect(result).toEqual({ op: 'noop' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
  });
});

describe('createCloudflareDnsClient — error mapping', () => {
  async function expectCode(handle: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const { client } = makeClient(handle);
    return failure(client.getRecord('dep-1'));
  }

  it('error code 9109 (invalid token) → CLOUDFLARE_AUTH_FAILED, token never leaked', async () => {
    const error = await expectCode(() => errResponse(403, 9109, 'Invalid API token.'));

    expect(error.code).toBe('CLOUDFLARE_AUTH_FAILED');
    expect(error.status).toBe(403);
    expect(error.message).not.toContain(TOKEN);
  });

  it('HTTP 403 permission → CLOUDFLARE_PERMISSION_DENIED', async () => {
    const error = await expectCode(() => errResponse(403, 1000, 'Zone.DNS permission denied.'));

    expect(error.code).toBe('CLOUDFLARE_PERMISSION_DENIED');
  });

  it('HTTP 429 → CLOUDFLARE_RATE_LIMITED with the retry-after seconds', async () => {
    const error = await expectCode(() => errResponse(429, 0, 'Too many requests.', { 'retry-after': '30' }));

    expect(error.code).toBe('CLOUDFLARE_RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('error code 81053 → CLOUDFLARE_DNS_CONFLICT', async () => {
    const error = await expectCode(() => errResponse(409, 81053, 'Duplicate record.'));

    expect(error.code).toBe('CLOUDFLARE_DNS_CONFLICT');
  });

  it('HTTP 500 → CLOUDFLARE_UNAVAILABLE', async () => {
    const error = await expectCode(() => errResponse(500, 0, 'Internal server error.'));

    expect(error.code).toBe('CLOUDFLARE_UNAVAILABLE');
  });

  it('a transport throw (network down) → CLOUDFLARE_UNAVAILABLE', async () => {
    const error = await expectCode(() => {
      throw new Error('connection reset');
    });

    expect(error.code).toBe('CLOUDFLARE_UNAVAILABLE');
    expect(error.message).not.toContain(TOKEN);
  });

  it('a transport abort (timeout) → CLOUDFLARE_UNAVAILABLE', async () => {
    const error = await expectCode(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    expect(error.code).toBe('CLOUDFLARE_UNAVAILABLE');
  });

  it('a non-JSON 5xx body (HTML error page) → CLOUDFLARE_UNAVAILABLE, not a crash', async () => {
    const { client } = makeClient(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const error = await failure(client.getRecord('dep-1'));

    expect(error.code).toBe('CLOUDFLARE_UNAVAILABLE');
    expect(error.status).toBe(502);
  });
});

describe('createCloudflareDnsClient — namespace protection before transport', () => {
  it('refuses reserved and out-of-zone names for every operation without a single call', async () => {
    const { client, calls } = makeClient(async () => {
      throw new Error('the transport must never be reached');
    });
    const hostileNames = [
      'app.deployz.dev',
      'www.deployz.dev',
      'deployz.dev',
      'admin.deployz.dev',
      'd-1.evil.com', // a default-looking name in the wrong zone
    ];

    for (const name of hostileNames) {
      expect((await failure(client.getRecord(name))).code).toBe('CLOUDFLARE_DNS_CONFLICT');
      expect((await failure(client.upsertDefaultDeploymentRecord(name, TARGET))).code).toBe(
        'CLOUDFLARE_DNS_CONFLICT',
      );
      expect((await failure(client.deleteDefaultDeploymentRecord(name))).code).toBe(
        'CLOUDFLARE_DNS_CONFLICT',
      );
    }

    expect(calls).toHaveLength(0);
  });
});

describe('createCloudflareDnsClient — hostname prefix', () => {
  it('an s- plane writes s-<id>.<zone> and refuses a validation name under d-<id>', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return okResult(record('rec-new', body['content'] as string, { name: body['name'] as string }));
    }, 's-');

    await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(calls[0]!.url).toBe(
      `${API_BASE_URL}/zones/${ZONE_ID}/dns_records?type=CNAME&name.exact=s-dep-1.${ZONE_NAME}`,
    );
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ name: `s-dep-1.${ZONE_NAME}` });
    expect((await failure(client.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE))).code).toBe(
      'CLOUDFLARE_DNS_CONFLICT',
    );
    expect(calls).toHaveLength(2);
  });
});

describe('createCloudflareDnsClient — concurrent-create race (81057)', () => {
  it('lost create, re-look-up still empty → a second POST succeeds (2 POSTs total)', async () => {
    let posts = 0;
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      if (init.method === 'POST') {
        posts += 1;
        if (posts === 1) return errResponse(409, 81057, 'Another object with the same name already exists.');
        return okResult(record('rec-new', TARGET));
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result.op).toBe('created');
    expect(posts).toBe(2);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
  });

  it('lost create, re-look-up finds the winner → reconciles with PUT (1 POST total)', async () => {
    let gets = 0;
    let posts = 0;
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') {
        gets += 1;
        return gets === 1 ? okList() : okList(record('rec-winner', 'winner-alb.example.com'));
      }
      if (init.method === 'POST') {
        posts += 1;
        return errResponse(409, 81057, 'Another object with the same name already exists.');
      }
      if (init.method === 'PUT') return okResult(record('rec-winner', TARGET));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultDeploymentRecord('dep-1', TARGET);

    expect(result).toMatchObject({ op: 'updated' });
    expect(posts).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'PUT']);
  });
});

describe('createFakeCloudflareDnsClient', () => {
  it('round-trips create → get → delete → get-null in memory', async () => {
    const fake = createFakeCloudflareDnsClient({ zoneId: ZONE_ID, zoneName: ZONE_NAME });

    const created = await fake.upsertDefaultDeploymentRecord('dep-1', TARGET);
    expect(created.op).toBe('created');
    expect(created.record).toMatchObject({
      type: 'CNAME',
      name: HOSTNAME,
      content: TARGET,
      ttl: 1,
      proxied: true,
    });

    const found = await fake.getRecord('dep-1');
    expect(found).toEqual(created.record);

    // A repeat upsert of the identical record is a noop, never a duplicate.
    const repeated = await fake.upsertDefaultDeploymentRecord('dep-1', TARGET);
    expect(repeated.op).toBe('noop');
    expect(fake.listRecords()).toHaveLength(1);

    expect(await fake.deleteDefaultDeploymentRecord('dep-1')).toEqual({ op: 'deleted' });
    expect(await fake.getRecord('dep-1')).toBeNull();
    expect(fake.listRecords()).toHaveLength(0);
  });

  it('applies the same namespace guard as the real client', async () => {
    const fake = createFakeCloudflareDnsClient({ zoneId: ZONE_ID, zoneName: ZONE_NAME });

    expect((await failure(fake.upsertDefaultDeploymentRecord('www.deployz.dev', TARGET))).code).toBe(
      'CLOUDFLARE_DNS_CONFLICT',
    );
    expect((await failure(fake.deleteDefaultDeploymentRecord('deployz.dev'))).code).toBe(
      'CLOUDFLARE_DNS_CONFLICT',
    );
    expect(fake.listRecords()).toHaveLength(0);
  });
});

describe('createCloudflareDnsClient — validation records (ACM DNS-01)', () => {
  const validationRecord = (
    id: string,
    overrides: Partial<CloudflareDnsRecord> = {},
  ): CloudflareDnsRecord => ({
    ...record(id, VALIDATION_VALUE, { name: VALIDATION_NAME, proxied: false }),
    ...overrides,
  });

  it('refuses validation names outside the deployment namespace before any transport call', async () => {
    const { client, calls } = makeClient(async () => {
      throw new Error('the transport must never be reached');
    });
    const hostileNames = [
      '_abc.www.deployz.dev', // suffix is a reserved hostname
      '_abc.d-dep-1.evil.com', // wrong zone
      '_abc.d-dep-2.deployz.dev', // another deployment's hostname
      'www.deployz.dev', // bare reserved name
      'deployz.dev', // bare apex
      `.${HOSTNAME}`, // empty label
    ];

    for (const name of hostileNames) {
      expect((await failure(client.upsertDefaultValidationRecord('dep-1', name, VALIDATION_VALUE))).code).toBe(
        'CLOUDFLARE_DNS_CONFLICT',
      );
      expect((await failure(client.deleteDefaultValidationRecord('dep-1', name))).code).toBe(
        'CLOUDFLARE_DNS_CONFLICT',
      );
    }

    expect(calls).toHaveLength(0);
  });

  it('accepts the absolute (trailing-dot) names ACM reports and writes them dot-less', async () => {
    // ACM's DomainValidationOptions[].ResourceRecord carries FQDNs with a
    // trailing dot; the relay forwards them verbatim. Observed live: the
    // guard refused every one of them and default HTTPS never left
    // WAITING_FOR_DNS.
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      if (init.method === 'POST') return okResult(validationRecord('rec-v'));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultValidationRecord('dep-1', `${VALIDATION_NAME}.`, VALIDATION_VALUE);

    expect(result.op).toBe('created');
    expect(calls[0]!.url).toContain(`name.exact=${encodeURIComponent(VALIDATION_NAME)}`);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ name: VALIDATION_NAME, content: VALIDATION_VALUE });

    calls.length = 0;
    await client.deleteDefaultValidationRecord('dep-1', `${VALIDATION_NAME}.`);
    expect(calls[0]!.url).toContain(`name.exact=${encodeURIComponent(VALIDATION_NAME)}`);
  });

  it('creates an UNPROXIED CNAME (ACM must see it) with the validation comment', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList();
      if (init.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return okResult(validationRecord('rec-v', { content: body['content'] as string }));
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);

    expect(result.op).toBe('created');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    const post = calls[1]!;
    expect(post.url).toBe(`${API_BASE_URL}/zones/${ZONE_ID}/dns_records`);
    expect(JSON.parse(post.body!)).toEqual({
      type: 'CNAME',
      name: VALIDATION_NAME,
      content: VALIDATION_VALUE,
      ttl: 1,
      proxied: false,
      comment: CLOUDFLARE_VALIDATION_RECORD_COMMENT,
    });
  });

  it('identical unproxied validation record → noop (list call only)', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(validationRecord('rec-v'));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);

    expect(result).toEqual({ op: 'noop', record: validationRecord('rec-v') });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('a proxied validation record (hidden from ACM) → PUT to restore proxied:false', async () => {
    const seenBodies: string[] = [];
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(validationRecord('rec-v', { proxied: true }));
      if (init.method === 'PUT') {
        seenBodies.push(init.body as string);
        return okResult(validationRecord('rec-v'));
      }
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);

    expect(result.op).toBe('updated');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(seenBodies[0]!)).toMatchObject({ name: VALIDATION_NAME, proxied: false });
  });

  it('deletes the validation record by its Cloudflare id', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(validationRecord('rec-v'));
      if (init.method === 'DELETE') return okResult(validationRecord('rec-v'));
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.deleteDefaultValidationRecord('dep-1', VALIDATION_NAME);

    expect(result).toEqual({ op: 'deleted' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1]!.url).toBe(`${API_BASE_URL}/zones/${ZONE_ID}/dns_records/rec-v`);
  });

  it('delete-miss (81044) → noop', async () => {
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(validationRecord('rec-v'));
      if (init.method === 'DELETE') return errResponse(400, 81044, 'Record does not exist.');
      throw new Error(`unexpected ${init.method}`);
    });

    expect(await client.deleteDefaultValidationRecord('dep-1', VALIDATION_NAME)).toEqual({ op: 'noop' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'DELETE']);
  });

  it('round-trips in the in-memory fake', async () => {
    const fake = createFakeCloudflareDnsClient({ zoneId: ZONE_ID, zoneName: ZONE_NAME });

    const created = await fake.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);
    expect(created.op).toBe('created');
    expect(created.record).toMatchObject({
      name: VALIDATION_NAME,
      content: VALIDATION_VALUE,
      ttl: 1,
      proxied: false,
      comment: CLOUDFLARE_VALIDATION_RECORD_COMMENT,
    });
    expect(fake.listRecords()).toHaveLength(1);

    const repeated = await fake.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);
    expect(repeated.op).toBe('noop');
    expect(fake.listRecords()).toHaveLength(1);

    expect(await fake.deleteDefaultValidationRecord('dep-1', VALIDATION_NAME)).toEqual({ op: 'deleted' });
    expect(await fake.deleteDefaultValidationRecord('dep-1', VALIDATION_NAME)).toEqual({ op: 'noop' });
    expect(fake.listRecords()).toHaveLength(0);
  });

  it('the fake refuses validation names outside the deployment namespace too', async () => {
    const fake = createFakeCloudflareDnsClient({ zoneId: ZONE_ID, zoneName: ZONE_NAME });

    expect((await failure(fake.upsertDefaultValidationRecord('dep-1', '_abc.www.deployz.dev', VALIDATION_VALUE))).code).toBe(
      'CLOUDFLARE_DNS_CONFLICT',
    );
    expect((await failure(fake.deleteDefaultValidationRecord('dep-1', '_abc.d-dep-1.evil.com'))).code).toBe(
      'CLOUDFLARE_DNS_CONFLICT',
    );
    expect(fake.listRecords()).toHaveLength(0);
  });
});

describe('listDefaultRecords (Phase 11 sweep)', () => {
  it('lists CNAMEs under the d- prefix with one bounded page and stops on a short page', async () => {
    const listed = [
      record('rec-1', TARGET, { name: `d-${crypto.randomUUID()}.${ZONE_NAME}` }),
      record('rec-2', TARGET, { name: `d-${crypto.randomUUID()}.${ZONE_NAME}` }),
    ];
    const { client, calls } = makeClient(async (_url, init) => {
      if (init.method === 'GET') return okList(...listed);
      throw new Error(`unexpected ${init.method}`);
    });

    const result = await client.listDefaultRecords();

    expect(result.map((entry) => entry.id)).toEqual(['rec-1', 'rec-2']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${API_BASE_URL}/zones/${ZONE_ID}/dns_records?type=CNAME&name.startswith=d-&per_page=100&page=1`,
    );
  });

  it('lists only the s- prefix for a plane configured with s-', async () => {
    const { client, calls } = makeClient(async () => okList(), 's-');

    await client.listDefaultRecords();

    expect(calls[0]!.url).toBe(
      `${API_BASE_URL}/zones/${ZONE_ID}/dns_records?type=CNAME&name.startswith=s-&per_page=100&page=1`,
    );
  });

  it('pages with per_page and stops at maxPages even when every page is full', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      record(`rec-${i}`, TARGET, { name: `d-${crypto.randomUUID()}.${ZONE_NAME}` }),
    );
    let page = 0;
    const { client, calls } = makeClient(async (url) => {
      page += 1;
      expect(url).toContain(`page=${page}`);
      return okList(...fullPage);
    });

    const result = await client.listDefaultRecords({ perPage: 100 });

    // 3 pages of 100, then the sweep stops — never a 4th transport call.
    expect(result).toHaveLength(300);
    expect(page).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('throws the classified error on a non-success response (state-only for the caller)', async () => {
    const { client } = makeClient(async () => errResponse(429, 0, 'rate limited', { 'retry-after': '30' }));

    const error = await failure(client.listDefaultRecords());
    expect(error.code).toBe('CLOUDFLARE_RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('the in-memory fake lists only its own d-* CNAMEs, bounded by perPage * maxPages', async () => {
    const fake = createFakeCloudflareDnsClient({ zoneId: ZONE_ID, zoneName: ZONE_NAME });
    for (let i = 0; i < 5; i += 1) {
      await fake.upsertDefaultDeploymentRecord(`dep-${i}`, TARGET);
    }
    await fake.upsertDefaultValidationRecord('dep-1', VALIDATION_NAME, VALIDATION_VALUE);

    const result = await fake.listDefaultRecords();
    expect(result).toHaveLength(5);
    expect(result.every((entry) => entry.name.startsWith('d-'))).toBe(true);

    expect(await fake.listDefaultRecords({ perPage: 2, maxPages: 2 })).toHaveLength(4);
  });
});

// Phase 13 — token hygiene. The zone-scoped API token travels ONLY as the
// Authorization header; it must never surface in an error message, a
// CloudflareDnsError field, or any serialization of a thrown object.
describe('token hygiene (Phase 13)', () => {
  const SENTINEL = 'sentinel-secret-token-123';

  function sentinelClient(handle: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: RecordedCall[] = [];
    const fetchFn: CloudflareFetchFn = async (url, init) => {
      calls.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string> });
      return handle(url, init);
    };
    const client = createCloudflareDnsClient({
      token: SENTINEL,
      zoneId: ZONE_ID,
      zoneName: ZONE_NAME,
      apiBaseUrl: API_BASE_URL,
      fetchFn,
    });
    return { client, calls };
  }

  function assertNoTokenLeak(...values: unknown[]): void {
    for (const value of values) {
      expect(String(value)).not.toContain(SENTINEL);
    }
    // A thrown error must serialize without the token anywhere.
    for (const value of values) {
      if (value instanceof Error) {
        expect(JSON.stringify({ message: value.message, code: (value as CloudflareDnsError).code })).not.toContain(
          SENTINEL,
        );
      }
    }
  }

  it.each([
    ['auth failure', () => errResponse(401, 9109, 'invalid token')],
    ['rate limit', () => jsonResponse(429, { success: false, errors: [], messages: [] }, { 'retry-after': '30' })],
    ['conflict', () => errResponse(409, 81057, 'record exists')],
  ] as const)('a %s never leaks the token into the error surface', async (_label, respond) => {
    const { client, calls } = sentinelClient(() => respond());

    try {
      await client.upsertDefaultDeploymentRecord('dep-1', TARGET);
      throw new Error('expected the upsert to fail');
    } catch (error) {
      assertNoTokenLeak(error);
      expect(String(error)).not.toContain(SENTINEL);
      // Every request still carried the sentinel as the credential — proving
      // the sentinel actually exercised the auth path.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.headers['Authorization']).toBe(`Bearer ${SENTINEL}`);
      }
    }
  });
});
