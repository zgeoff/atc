import { makeSingleFlight } from '@atc/core';
import { restartDaemon } from './restart-daemon';
import type { RestartDaemonDeps } from './restart-daemon';

// The restart the client runs on a key press: one at a time, with the machine told when it starts
// and when it ends.
export function createDaemonRestarter<TLink>(deps: RestartDaemonDeps<TLink>): () => Promise<void> {
  return makeSingleFlight(async () => {
    deps.service.send({ type: 'RESTART_STARTED' });
    deps.overlay.render();

    try {
      await restartDaemon(deps);
    } finally {
      deps.service.send({
        type: 'RESTART_ENDED',
        connected: deps.transport.readState() === 'ready',
      });

      deps.scheduleStatus();
    }
  });
}
