import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubAttentionAdapter } from '@atc/test-utils';
import { startTestDaemon } from './start-test-daemon';

// A test daemon on a loopback TCP port that stands in for a daemon on another host. It takes the
// principal `laptop` with the token `aaaa…` (32 letters a), and its sessions echo each line typed into them as `GOT-REMOTE:<line>`, so a
// test sees where input went. `port` 0 takes any free port.
export async function startRemoteTestDaemon(port = 0) {
  const remote = await startTestDaemon({
    options: (paths) => {
      writeFileSync(join(paths.directory, 'gateway-token'), `${'a'.repeat(32)}\n`);

      return {
        adapter: buildStubAttentionAdapter({
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
    },
  });

  if (remote.daemon.listenPort === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  return remote;
}
