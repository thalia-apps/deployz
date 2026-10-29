import { describe, expect, it } from 'vitest';

import { resolveGithubSetupRoute } from '../src/lib/github-setup';

describe('resolveGithubSetupRoute', () => {
  const apiUrl = 'https://api.example.test';

  it('reports a missing installation id rather than guessing one', () => {
    expect(resolveGithubSetupRoute({ installationId: undefined, signedIn: true, apiUrl })).toEqual({
      kind: 'missing',
    });
  });

  // GitHub sends the installing vendor here whether or not they hold a Deployz
  // session. Signed out they must land on sign-in, carrying the installation
  // id so the binding still completes once they are back.
  it('sends a signed-out vendor to sign-in, carrying the installation id', () => {
    expect(resolveGithubSetupRoute({ installationId: '4242', signedIn: false, apiUrl })).toEqual({
      kind: 'sign-in',
      href: '/sign-in?callbackUrl=%2Fgithub%2Fsetup%3Finstallation_id%3D4242',
    });
  });

  it('sends a signed-in vendor to the API route that binds the installation', () => {
    expect(resolveGithubSetupRoute({ installationId: '4242', signedIn: true, apiUrl })).toEqual({
      kind: 'bind',
      href: 'https://api.example.test/api/github/setup?installation_id=4242',
    });
  });

  it('carries the signed state through sign-in and to the API route', () => {
    expect(
      resolveGithubSetupRoute({ installationId: '4242', state: 'a.b.c', signedIn: false, apiUrl }),
    ).toEqual({
      kind: 'sign-in',
      href: '/sign-in?callbackUrl=%2Fgithub%2Fsetup%3Finstallation_id%3D4242%26state%3Da.b.c',
    });
    expect(
      resolveGithubSetupRoute({ installationId: '4242', state: 'a.b.c', signedIn: true, apiUrl }),
    ).toEqual({
      kind: 'bind',
      href: 'https://api.example.test/api/github/setup?installation_id=4242&state=a.b.c',
    });
  });

  it('carries the OAuth code through sign-in and to the API route', () => {
    expect(
      resolveGithubSetupRoute({ installationId: '4242', state: 'a.b.c', code: 'c0de', signedIn: false, apiUrl }),
    ).toEqual({
      kind: 'sign-in',
      href: '/sign-in?callbackUrl=%2Fgithub%2Fsetup%3Finstallation_id%3D4242%26state%3Da.b.c%26code%3Dc0de',
    });
    expect(
      resolveGithubSetupRoute({ installationId: '4242', state: 'a.b.c', code: 'c0de', signedIn: true, apiUrl }),
    ).toEqual({
      kind: 'bind',
      href: 'https://api.example.test/api/github/setup?installation_id=4242&state=a.b.c&code=c0de',
    });
  });

  // The id reaches us straight from a query string, so it lands in both a
  // relative callback and an API URL without ever being trusted verbatim.
  it('escapes an installation id that carries query syntax', () => {
    const route = resolveGithubSetupRoute({ installationId: '1&x=2', signedIn: true, apiUrl });
    expect(route).toEqual({
      kind: 'bind',
      href: 'https://api.example.test/api/github/setup?installation_id=1%26x%3D2',
    });
  });
});
