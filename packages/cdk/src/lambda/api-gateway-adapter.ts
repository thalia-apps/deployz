/**
 * Translation between API Gateway HTTP API (payload format 2.0) events and
 * Fastify's `inject()`.
 *
 * This lives apart from api-handler.ts on purpose. The handler module imports
 * the whole API, drizzle, pg and the bundled .sql migrations, so it cannot be
 * loaded in a unit test — which is precisely how two cookie defects shipped to
 * production unnoticed. The translation is pure, so it is tested directly.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS';

export interface InjectOptions {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Buffer;
}

/** The shape of a Fastify `inject()` result that this module reads. */
export interface InjectedResponse {
  readonly statusCode: number;
  readonly headers?: Record<string, string | string[] | number | undefined>;
  readonly body: string;
}

export function toInjectOptions(event: APIGatewayProxyEventV2): InjectOptions {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';

  const headers: Record<string, string> = {
    ...((event.headers as Record<string, string>) ?? {}),
  };

  // Payload format 2.0 strips request cookies OUT of `headers` and into
  // `event.cookies`. Reading only `headers` leaves the app with no Cookie
  // header at all, so every session lookup fails and the API answers 401 in
  // production while working perfectly against a local HTTP server.
  if (event.cookies && event.cookies.length > 0) {
    headers.cookie = event.cookies.join('; ');
  }

  // The webhook routes verify signatures over the raw body, so the exact
  // bytes have to survive. API Gateway base64-encodes bodies it judges
  // binary; decoding to a Buffer keeps those signature checks honest.
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;

  return {
    method: event.requestContext.http.method as HttpMethod,
    url: `${event.rawPath}${query}`,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

export function toLambdaResult(
  response: InjectedResponse,
): APIGatewayProxyStructuredResultV2 {
  // Fastify hands back `set-cookie` as a string[] whenever more than one
  // cookie is set — and Better Auth sets the OAuth state and PKCE cookies
  // together. Stringifying that array comma-joins it into one malformed
  // header, so the cookies go into payload format 2.0's dedicated `cookies`
  // field, which is what it exists for.
  const headers: Record<string, string> = {};
  let cookies: string[] = [];

  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (value === undefined) continue;
    if (key.toLowerCase() === 'set-cookie') {
      cookies = Array.isArray(value) ? value.map(String) : [String(value)];
      continue;
    }
    headers[key] = String(value);
  }

  return {
    statusCode: response.statusCode,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
    body: response.body,
    isBase64Encoded: false,
  };
}
