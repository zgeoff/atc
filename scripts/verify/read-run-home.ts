import { join } from 'node:path';

export interface RunHome {
  // The folder `with-test-home.sh` made for the run, which every process of the run holds in
  // ATC_TEST_HOME.
  readonly root: string;
  readonly home: string;
  readonly runtime: string;

  // The source entries of the `atc` and `atc-gateway` commands.
  readonly cli: string;
  readonly gateway: string;
}

// The run's folders, from the variables `with-test-home.sh` exports.
export function readRunHome(env: Readonly<Record<string, string | undefined>>): RunHome {
  const root = env['ATC_TEST_HOME'];
  const cli = env['ATC_CLI_ENTRY'];
  const gateway = env['ATC_GATEWAY_ENTRY'];

  if (!isSet(root) || !isSet(cli) || !isSet(gateway)) {
    throw new Error(
      'ATC_TEST_HOME, ATC_CLI_ENTRY and ATC_GATEWAY_ENTRY are unset: start this through with-test-home.sh',
    );
  }

  return { root, home: join(root, 'home'), runtime: join(root, 'runtime'), cli, gateway };
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}
