interface TestHost {
  readonly cpus: number;
  readonly memoryBytes: number;

  // The TEST_WORKERS value the environment holds, if any.
  readonly requested: string | undefined;
}

// On a host with 2 CPUs and 2 GiB, the test script's default worker count
// kept the slowest tests near the 5 s timeout, and one worker stalled 10 s
// under memory pressure; one worker passed.
const SMALL_HOST_CPUS = 2;
const SMALL_HOST_MEMORY_BYTES = 2 * 1024 ** 3;

export function pickTestWorkers(host: TestHost): number | null {
  if (host.requested !== undefined) {
    return null;
  }

  if (host.cpus <= SMALL_HOST_CPUS || host.memoryBytes <= SMALL_HOST_MEMORY_BYTES) {
    return 1;
  }

  return null;
}
