/**
 * The path of the source entry a test runs atc or atc-gateway from, which
 * `scripts/with-test-home.sh` exports before Bun starts. Throws when the
 * variable is unset, since a run outside the wrapper has no entry to use.
 */
export function getSourceEntry(command: 'atc' | 'atc-gateway'): string {
  const name = command === 'atc' ? 'ATC_CLI_ENTRY' : 'ATC_GATEWAY_ENTRY';
  const path = process.env[name];

  if (path === undefined || path === '') {
    throw new Error(`${name} is unset: run tests through scripts/with-test-home.sh`);
  }

  return path;
}
