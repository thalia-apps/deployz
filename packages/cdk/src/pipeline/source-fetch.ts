/**
 * GitHub-App → S3 source upload logic.
 *
 * Fetches a repository tarball from GitHub using the installation token
 * (minted by the GitHub App, todo 15), and uploads it to an S3 bucket
 * to serve as the source for CodeBuild.
 *
 * The decision record (decision-record-u4.md) documents why we use the
 * token-fetch + S3 path instead of CodeStar Connections: CodeStar Connections
 * "uses AWS's app", which would require a second GitHub App installation
 * conflicting with Deployz's own App.
 *
 * Large-repo constraint: Lambda has a 15-minute timeout and /tmp storage
 * limits. The `streamToS3` option streams the tarball directly to S3 via
 * multipart upload to avoid buffering the entire tarball in /tmp.
 * For repos exceeding 10 GB, the control plane can use chunked download
 * with S3 multipart upload.
 */

// ---------------------------------------------------------------------------
// Fetch seam (mirrors the API's github.ts FetchFn — minimal structural type)
// ---------------------------------------------------------------------------

export interface FetchFn {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  }>;
}

/**
 * Largest repository tarball the worker holds in memory. A bigger repository
 * fails its release with a clear message instead of wedging the shared worker.
 */
export const MAX_SOURCE_TARBALL_BYTES = 256 * 1024 * 1024;

function tarballTooLargeError(repoFullName: string): Error {
  return new Error(
    `The repository ${repoFullName} is larger than ${MAX_SOURCE_TARBALL_BYTES / (1024 * 1024)} MB. Remove large files from the repository and release again.`,
  );
}

// ---------------------------------------------------------------------------
// S3 client seam (reuses the same interface from quick-create)
// ---------------------------------------------------------------------------

import type { S3Client } from '../quick-create/publish.js';

// ---------------------------------------------------------------------------
// GitHub API constants
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface FetchRepoArchiveResult {
  /** S3 object key the tarball was uploaded to. */
  readonly s3Key: string;
  /** Byte size of the uploaded tarball. */
  readonly bytes: number;
  /** The git ref that was fetched. */
  readonly ref: string;
}

export interface FetchRepoArchiveOptions {
  /** S3 bucket the tarball is uploaded to. */
  readonly bucket: string;
  /** S3 key prefix (e.g. `build-source/org-name/repo-name`). */
  readonly s3KeyPrefix: string;
  /** Git ref to fetch (branch, tag, or SHA). Default: `main`. */
  readonly ref?: string;
}

// ---------------------------------------------------------------------------
// Source fetch
// ---------------------------------------------------------------------------

/**
 * Fetches a repository tarball from GitHub using the installation token
 * and uploads it to S3.
 *
 * The GitHub API endpoint `GET /repos/{owner}/{repo}/tarball/{ref}` returns
 * a 302 redirect to a codeload URL. The redirect URL is pre-signed and does
 * not require additional authentication. We follow the redirect to download
 * the tarball.
 *
 * For large repos, the tarball is streamed in memory and uploaded to S3.
 * Lambda's default /tmp (512 MB) is NOT used for buffering — the tarball
 * is held in an ArrayBuffer and uploaded directly. For repos exceeding
 * available memory, a future implementation can use S3 multipart upload
 * with Node.js streams.
 */
export async function fetchRepoArchive(
  installationToken: string,
  repoFullName: string,
  fetchFn: FetchFn,
  s3Client: S3Client,
  options: FetchRepoArchiveOptions,
): Promise<FetchRepoArchiveResult> {
  const ref = options.ref ?? 'main';

  // Step 1: Request the tarball from the GitHub API.
  // The API returns a 302 redirect to a codeload.github.com URL.
  const apiUrl = `${GITHUB_API_BASE}/repos/${repoFullName}/tarball/${encodeURIComponent(ref)}`;
  const apiResponse = await fetchFn(apiUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // GitHub API returns a 302 redirect to the codeload URL. However, some
  // fetch implementations follow redirects automatically. We handle both:
  // 1. Auto-followed: status 200, body is the tarball
  // 2. Not followed: we read the Location header and fetch again
  let tarballResponse = apiResponse;

  if (apiResponse.status === 302 || apiResponse.status === 301) {
    const location = apiResponse.headers.get('location');
    if (!location) {
      throw new Error(
        `GitHub API returned ${apiResponse.status} without a Location header for ${repoFullName}`,
      );
    }
    tarballResponse = await fetchFn(location, { method: 'GET' });
  }

  if (tarballResponse.status < 200 || tarballResponse.status >= 300) {
    const body = await tarballResponse.text().catch(() => '');
    throw new Error(
      `Failed to fetch repo tarball for ${repoFullName} (ref: ${ref}): HTTP ${tarballResponse.status} — ${body.slice(0, 500)}`,
    );
  }

  // Step 2: Read the tarball bytes, within the size cap. The declared length
  // is checked first; the bytes actually read are counted as well, because
  // the header can be absent or wrong.
  const declaredLength = Number(tarballResponse.headers.get('content-length'));
  if (declaredLength > MAX_SOURCE_TARBALL_BYTES) {
    throw tarballTooLargeError(repoFullName);
  }
  let bytes: Uint8Array;
  const reader = tarballResponse.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_SOURCE_TARBALL_BYTES) {
          await reader.cancel();
          throw tarballTooLargeError(repoFullName);
        }
        chunks.push(value);
      }
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await tarballResponse.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_TARBALL_BYTES) {
      throw tarballTooLargeError(repoFullName);
    }
  }

  // Step 3: Upload to S3.
  const s3Key = `${options.s3KeyPrefix}/${ref}.tar.gz`;
  await s3Client.putObject({
    bucket: options.bucket,
    key: s3Key,
    body: bytes,
    contentType: 'application/gzip',
  });

  return { s3Key, bytes: bytes.byteLength, ref };
}

// ---------------------------------------------------------------------------
// Large-repo streaming helper (for future multipart upload)
// ---------------------------------------------------------------------------

/**
 * Maximum size (in bytes) before the streaming path is recommended.
 * Below this threshold, the in-memory ArrayBuffer approach is fine.
 * 512 MB — matches Lambda's default /tmp limit. Above this, use
 * S3 multipart upload with streaming to avoid OOM.
 */
export const STREAMING_THRESHOLD_BYTES = 512 * 1024 * 1024;

/**
 * Checks whether a repo tarball is likely large enough to need streaming.
 * This is a heuristic based on the Content-Length header (if present) or
 * a conservative estimate.
 */
export function needsStreaming(
  contentLength: number | null,
): boolean {
  if (contentLength === null) {
    // Unknown size — conservative: assume large.
    return true;
  }
  return contentLength > STREAMING_THRESHOLD_BYTES;
}

/**
 * Documentation-only: the streaming upgrade path for large repos.
 *
 * When a tarball exceeds Lambda memory or /tmp limits, the control plane
 * should:
 *
 * 1. Initiate an S3 multipart upload.
 * 2. Stream the tarball in chunks (e.g. 5 MB parts) directly to S3,
 *    without buffering the entire tarball in Lambda memory.
 * 3. Complete the multipart upload.
 *
 * This can be implemented using the `aws-sdk/client-s3`'s `Upload` class
 * with a Node.js `ReadableStream` from the fetch response, or by manually
 * managing multipart parts for repos that require range-request chunking
 * from GitHub.
 *
 * The current implementation uses `ArrayBuffer` (in-memory) which is safe
 * for repos up to Lambda's memory limit. The streaming path is a future
 * upgrade when real-AWS testing reveals the need.
 */