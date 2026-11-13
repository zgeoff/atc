import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import type { TestDaemonConfig } from '@atc/daemon/testing';
import { buildStubAttentionAdapter } from '@atc/test-utils';
import { toAgentSessionID } from '@atcx/contract';
import { startTestDaemon } from './start-test-daemon';

// A test daemon on a loopback TCP port that stands in for a daemon on another host. It takes the
// principal `laptop` with the token `aaaa…` (32 letters a), and its sessions echo each line typed into them as `GOT-REMOTE:<line>`, so a
// test sees where input went. `port` 0 takes any free port.
type OptionsBuilder = NonNullable<TestDaemonConfig['options']>;

type TestDaemonPaths = Parameters<OptionsBuilder>[0];

type TestDaemonOptions = Awaited<ReturnType<OptionsBuilder>>;

// The options of the remote test daemon, which a restart passes again with the port it bound.
export function writeRemoteTestDaemonOptions(
  paths: TestDaemonPaths,
  port: number,
): TestDaemonOptions {
  writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

  return {
    adapter: buildStubAttentionAdapter({
      // A hook line that carries a `session_id` records it as the agent session id, which a
      // restore needs to resume the session.
      planHookEvents: (hook) => ({
        events: [
          {
            kind: hook.event === 'Notification' ? 'needs-input' : 'prompt-submitted',
            ...(isRecord(hook.payload) && typeof hook.payload['session_id'] === 'string'
              ? { agentSessionID: toAgentSessionID(hook.payload['session_id']) }
              : {}),
          },
        ],
      }),
      planSpawn: () => ({
        bin: 'bash',
        args: ['-c', 'echo REMOTE_UP; while read -r line; do echo "GOT-REMOTE:$line"; done'],
      }),
    }),
    principals: new Map([['laptop', ['local']]]),
    listen: {
      host: '127.0.0.1',
      port,
      tokenFile: join(paths.directory, 'gateway-token'),
      failureDelayMs: 0,
    },
  };
}

export async function startRemoteTestDaemon(port = 0) {
  const remote = await startTestDaemon({
    options: (paths) => writeRemoteTestDaemonOptions(paths, port),
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  return remote;
}
