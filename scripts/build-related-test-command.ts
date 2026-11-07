import type { WorkerCount } from './read-worker-count.ts';

export type RelatedTestCommand =
  | { readonly kind: 'run'; readonly command: readonly string[] }
  | { readonly kind: 'invalid'; readonly message: string };

// A host with one worker runs each file slower than CI, and a test that passes there must not fail
// the push.
const slowHostTestTimeoutMs = 15_000;

export function buildRelatedTestCommand(
  tests: readonly string[],
  workers: WorkerCount,
): RelatedTestCommand {
  if (workers.kind === 'invalid') {
    return workers;
  }

  // Without `--no-isolate`, `bun test --parallel` gives each file a fresh global, while a test
  // script with neither flag runs every file in one global.
  const flags = [
    `--parallel=${workers.count}`,
    '--no-isolate',
    ...(workers.count === 1 ? [`--timeout=${slowHostTestTimeoutMs}`] : []),
  ];

  // bun test reads a bare argument as a name filter; the ./ makes it a path.
  return {
    kind: 'run',
    command: ['bun', 'run', 'test', ...flags, ...tests.map((path) => `./${path}`)],
  };
}
