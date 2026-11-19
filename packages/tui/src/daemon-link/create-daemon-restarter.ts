import { makeSingleFlight } from '@atc/core';
import { restartDaemon } from './restart-daemon';
import type { RestartDaemonDeps } from './restart-daemon';

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
