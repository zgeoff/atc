import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { buildStubAttentionAdapter } from '@atc/daemon/test-utils/build-stub-attention-adapter';
import type { TestDaemonConfig } from '@atc/daemon/test-utils/start-test-daemon';
import { toAgentSessionID } from '@atcx/contract';
import { startTestDaemon } from './start-test-daemon';

type OptionsBuilder = NonNullable<TestDaemonConfig['options']>;

type TestDaemonPaths = Parameters<OptionsBuilder>[0];

type TestDaemonOptions = Awaited<ReturnType<OptionsBuilder>>;

export function writeRemoteTestDaemonOptions(
  paths: TestDaemonPaths,
  port: number,
): TestDaemonOptions {
  writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

  return {
    adapter: buildStubAttentionAdapter({
      // A restore resumes the agent session by this id,
      // so the stub passes the hook's session_id through.
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
