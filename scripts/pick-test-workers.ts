interface TestHost {
  readonly cpus: number;
  readonly memoryBytes: number;
}

// On a host with 2 CPUs and 2 GiB, two workers and the processes their tests
// spawn kept full-suite tests near the 5 s timeout, and one worker stalled
// 10 s under memory pressure.
const SMALL_HOST_CPUS = 2;
const SMALL_HOST_MEMORY_BYTES = 2 * 1024 ** 3;

export function pickTestWorkers(host: TestHost): number {
  if (host.cpus <= SMALL_HOST_CPUS || host.memoryBytes <= SMALL_HOST_MEMORY_BYTES) {
    return 1;
  }

  return host.cpus;
}
