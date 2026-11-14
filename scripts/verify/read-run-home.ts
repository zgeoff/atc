import { join } from 'node:path';

export interface RunHome {
  // The folder `with-test-home.sh` made for the run, which every process of the run holds in
  // ATC_TEST_HOME.
  readonly root: string;
  readonly home: string;
  readonly runtime: string;

  // The source entry of the `atc` command.
  readonly cli: string;
}

// The run's folders, from the variables `with-test-home.sh` exports.
export function readRunHome(env: Readonly<Record<string, string | undefined>>): RunHome {
  const root = env['ATC_TEST_HOME'];
  const cli = env['ATC_CLI_ENTRY'];

  if (root === undefined || root === '' || cli === undefined || cli === '') {
    throw new Error(
      'ATC_TEST_HOME and ATC_CLI_ENTRY are unset: start this through with-test-home.sh',
    );
  }

  return { root, home: join(root, 'home'), runtime: join(root, 'runtime'), cli };
}
