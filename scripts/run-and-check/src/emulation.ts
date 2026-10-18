/**
 * What an amd64 program shows when QEMU fails under it: QEMU's own crash
 * lines (PHP's built-in server), and the Go runtime's crashes on a
 * non-canonical address or its lock-free stack, which a real x86_64 CPU
 * cannot produce (F5 crashed so in about 3 of 4 starts). RoadRunner (shlink) loses its PHP workers under
 * QEMU with `static_pool_allocate_workers: EOF` and serves HTTP natively.
 */
export const QEMU_CRASH =
  /qemu-x86_64: QEMU internal SIGSEGV|qemu: uncaught target signal|fatal error: lfstack\.push|sigcode=\d+ addr=0xffff[0-9a-f]{8,}|static_pool_allocate_workers: EOF/;

/** A name lookup that failed: the app needs the internet at run time, which the run network does not give. */
export const NO_INTERNET = /EAI_AGAIN|ENOTFOUND|getaddrinfo|Temporary failure in name resolution|Could not resolve host|Name or service not known/;

/** The first line of a log that shows a limit of the test rather than an app result. */
export function runtimeLimit(log: string): { kind: 'emulation' | 'internet'; line: string } | null {
  for (const line of log.split('\n')) {
    if (QEMU_CRASH.test(line)) return { kind: 'emulation', line: line.trim() };
    if (NO_INTERNET.test(line)) return { kind: 'internet', line: line.trim() };
  }
  return null;
}
