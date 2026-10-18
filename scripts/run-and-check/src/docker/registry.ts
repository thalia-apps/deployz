/**
 * Where the official Docker library images (alpine, postgres, mysql) come
 * from. ECR Public by default. GitHub runners set
 * `RUNCHECK_LIBRARY_REGISTRY=docker.io/library`: their shared IP addresses
 * exceed the ECR Public anonymous data limit. Both registries serve the same
 * official images.
 */
export const LIBRARY_REGISTRY = process.env.RUNCHECK_LIBRARY_REGISTRY || 'public.ecr.aws/docker/library';

export function libraryImage(nameAndTag: string): string {
  return `${LIBRARY_REGISTRY}/${nameAndTag}`;
}
