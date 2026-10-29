// The GitHub App's Setup URL lands here. GitHub sends the installing vendor
// to it right after they install (or reconfigure) the App, with
// `installation_id` in the query — but it has no idea whether they hold a
// Deployz session, so this page has to work signed out.
//
// The decision lives here rather than in the page so it can be tested without
// a Next server runtime, the same split as `host-routing.ts` and middleware.
//
// Only the API can bind an installation to an organization: the binding needs
// the vendor's session AND the App's private key. So a signed-in vendor is
// forwarded to `GET /api/github/setup`, which does the work and redirects on
// to the dashboard.

interface GithubSetupInput {
  /** `installation_id` from the query string, absent if GitHub omitted it. */
  readonly installationId: string | undefined;
  /** `state` from the query string: the signed value the API issued when the install started. */
  readonly state?: string | undefined;
  /** `code` from the query string: GitHub's OAuth code, sent when the App asks for user authorization during installation. */
  readonly code?: string | undefined;
  readonly signedIn: boolean;
  /** The API origin the BROWSER can reach — this is a redirect target. */
  readonly apiUrl: string;
}

type GithubSetupRoute =
  | { readonly kind: 'missing' }
  | { readonly kind: 'sign-in'; readonly href: string }
  | { readonly kind: 'bind'; readonly href: string };

/** Where the vendor goes next, or `missing` when there is nothing to bind. */
export function resolveGithubSetupRoute({
  installationId,
  state,
  code,
  signedIn,
  apiUrl,
}: GithubSetupInput): GithubSetupRoute {
  if (!installationId) {
    return { kind: 'missing' };
  }

  const query =
    `installation_id=${encodeURIComponent(installationId)}` +
    (state ? `&state=${encodeURIComponent(state)}` : '') +
    (code ? `&code=${encodeURIComponent(code)}` : '');

  // Signed out: sign in first, then come back here and bind. The callback is
  // deliberately RELATIVE — the sign-in page rejects absolute URLs to close
  // off open redirects, and this path is on the same origin anyway.
  if (!signedIn) {
    const callbackUrl = encodeURIComponent(`/github/setup?${query}`);
    return { kind: 'sign-in', href: `/sign-in?callbackUrl=${callbackUrl}` };
  }

  return { kind: 'bind', href: `${apiUrl}/api/github/setup?${query}` };
}
