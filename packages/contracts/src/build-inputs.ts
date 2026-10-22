import { z } from 'zod';

/**
 * Vendor-controlled strings that reach the release build (CodeBuild
 * environment, the image tag and the Docker command line). The API checks
 * them when they are written and the worker checks them again before it
 * starts a build.
 */
export const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/;
export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A path inside the repository: no leading `/`, no `..` segment, no backslash, no NUL. */
export function isRepoRelativePath(value: string): boolean {
  return (
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

export const repoRelativePathSchema = z
  .string()
  .max(500)
  .refine(isRepoRelativePath, 'Use a path inside the repository: no leading "/", no ".." and no "\\"');
