export interface SessionContainers {
  readonly containers: string[];
  readonly harness: string | undefined;
}

// The daemon runs each command on a session's host in a throwaway container under the same
// prefix, and Docker's name filter matches any name that holds the prefix.
export function collectSessionContainers(
  names: readonly string[],
  prefix: string,
): SessionContainers {
  const containers = names
    .filter((name) => name.startsWith(prefix) && !name.startsWith(`${prefix}run-`))
    .toSorted();

  return {
    containers,
    harness: containers.find((name) => !name.endsWith('-relay')),
  };
}
