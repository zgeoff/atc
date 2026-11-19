import type { DaemonClient } from '@atc/protocol/client';
import { createActor } from 'xstate';
import { buildClientMachine } from '../client/build-client-machine';
import { createSessionActions } from '../client/create-session-actions';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import { buildStubClientScreens } from './build-stub-client-screens';

export function createSessionActionsHarness(client: Pick<DaemonClient, 'sendRequest'>) {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  const overlay: Pick<OverlayScreen, 'notice' | 'render'> = {
    notice: null,
    render: () => {},
  };

  const actions = createSessionActions({
    service,
    mirror: createFleetMirror(null),
    overlay,
    links: { clientFor: () => client, stateOf: () => ({ kind: 'up' }) },
    getMode: () => service.getSnapshot().value.mode,
    attach: () => Promise.resolve(),
    ptyRows: () => 24,
    reportFailure: () => {},
  });

  return {
    service,
    overlay,
    actions,
    stop: () => {
      service.stop();
    },
  };
}
