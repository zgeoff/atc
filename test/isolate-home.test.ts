import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { GatewayAdapter } from '../src/agents/gateway-adapter';
import {
  configFile,
  daemonPidFile,
  daemonSocketPath,
  dbFile,
  eventsSocketPath,
  legacyFleetFile,
  mcpAuthDBFile,
  parseConfig,
  socketPath,
  stateDir,
  statusFile,
} from '../src/shared/config';

test("it resolves every atc config, state, and socket path under a temporary directory, never the account's home", () => {
  const paths = [
    configFile,
    stateDir,
    statusFile,
    dbFile,
    mcpAuthDBFile,
    legacyFleetFile,
    daemonPidFile,
    socketPath,
    daemonSocketPath,
    eventsSocketPath,
  ];

  expect(paths).toSatisfyAll(
    (path: string) => path.startsWith(tmpdir()) && !path.startsWith(userInfo().homedir),
  );
});

test("it writes a gateway's generated settings file under the temporary state directory", () => {
  if (!stateDir.startsWith(tmpdir())) {
    throw new Error(`refusing to write: the state directory ${stateDir} is not a temporary one`);
  }

  const adapter = new GatewayAdapter(
    {
      id: 'isolation-probe',
      label: 'Isolation probe',
      mark: 'i',
      bin: 'claude',
      args: [],
      baseURL: 'https://gateway.example/anthropic',
      env: {},
    },
    parseConfig({}),
  );

  const command = adapter.buildResumeCommand('/tmp', undefined);

  expect(command).toInclude(join(stateDir, 'hook-settings-isolation-probe.json'));
  expect(existsSync(join(stateDir, 'hook-settings-isolation-probe.json'))).toBe(true);
});
