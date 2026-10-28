import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { toInjectOptions, toLambdaResult } from '../src/lambda/api-gateway-adapter.js';

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/me',
    rawQueryString: '',
    headers: { host: 'api.deployz.dev' },
    requestContext: { http: { method: 'GET' } },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

describe('toInjectOptions', () => {
  // The bug this guards: payload format 2.0 moves request cookies out of
  // `headers` and into `event.cookies`. Reading only `headers` made every
  // authenticated request in production resolve to no session at all.
  it('rebuilds the Cookie header from event.cookies', () => {
    const options = toInjectOptions(
      event({ cookies: ['__Secure-better-auth.session_token=abc', 'other=1'] }),
    );

    expect(options.headers.cookie).toBe('__Secure-better-auth.session_token=abc; other=1');
  });

  it('leaves the Cookie header alone when there are no cookies', () => {
    expect(toInjectOptions(event()).headers.cookie).toBeUndefined();
  });

  it('keeps the path and query string together', () => {
    const options = toInjectOptions(
      event({ rawPath: '/api/deployments', rawQueryString: 'page=2&status=healthy' }),
    );

    expect(options.url).toBe('/api/deployments?page=2&status=healthy');
    expect(options.method).toBe('GET');
  });

  it('passes a plain body through untouched', () => {
    const options = toInjectOptions(event({ body: '{"name":"acme"}' }));

    expect(options.body).toBe('{"name":"acme"}');
  });

  // Webhook signature verification reads the raw bytes, so a base64 body has
  // to be decoded or the webhook signature fails with an opaque 400.
  it('decodes a base64-encoded body to the original bytes', () => {
    const raw = '{"id":"evt_123"}';
    const options = toInjectOptions(
      event({ body: Buffer.from(raw).toString('base64'), isBase64Encoded: true }),
    );

    expect(Buffer.isBuffer(options.body)).toBe(true);
    expect((options.body as Buffer).toString()).toBe(raw);
  });

  it('omits the body entirely when the event has none', () => {
    expect(toInjectOptions(event()).body).toBeUndefined();
  });
});

describe('toLambdaResult', () => {
  // The other half of the bug: String(['a','b']) is 'a,b', which collapses two
  // Set-Cookie headers into one malformed one. Better Auth sets the OAuth
  // state and PKCE cookies together, so this broke GitHub sign-in outright.
  it('moves multiple set-cookie values into the cookies field', () => {
    const result = toLambdaResult({
      statusCode: 302,
      headers: {
        'set-cookie': ['state=xyz; Path=/', 'pkce=abc; Path=/'],
        location: 'https://github.com/login/oauth/authorize',
      },
      body: '',
    });

    expect(result.cookies).toEqual(['state=xyz; Path=/', 'pkce=abc; Path=/']);
    expect(result.headers).not.toHaveProperty('set-cookie');
    expect(result.headers?.location).toBe('https://github.com/login/oauth/authorize');
  });

  it('still moves a single set-cookie value into the cookies field', () => {
    const result = toLambdaResult({
      statusCode: 200,
      headers: { 'set-cookie': 'session=1; Path=/' },
      body: '{}',
    });

    expect(result.cookies).toEqual(['session=1; Path=/']);
  });

  it('omits cookies when the response sets none', () => {
    const result = toLambdaResult({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });

    expect(result.cookies).toBeUndefined();
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('drops undefined header values and stringifies the rest', () => {
    const result = toLambdaResult({
      statusCode: 204,
      headers: { 'content-length': 0, 'x-missing': undefined },
      body: '',
    });

    expect(result.headers).toEqual({ 'content-length': '0' });
  });
});
