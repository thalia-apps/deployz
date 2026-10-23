// Only a same-origin relative path is a safe redirect target. A backslash is
// rejected because URL parsers read "/\evil.com" as "//evil.com"; the origin
// check catches every other form that resolves to a different host.
export function isSafeCallbackUrl(url: string | null): url is string {
  if (url === null || !url.startsWith('/') || url.includes('\\')) {
    return false;
  }
  const base = 'http://callback.invalid';
  return new URL(url, base).origin === base;
}
