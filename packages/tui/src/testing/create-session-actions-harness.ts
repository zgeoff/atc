import type { DaemonClient } from '@atc/protocol/client';
import { createActor } from 'xstate';
import { buildClientMachine } from '../build-client-machine';
import { createFleetMirror } from '../create-fleet-mirror';
import type { OverlayScreen } from '../create-overlay-screen';
import { createSessionActions } from '../create-session-actions';
import { buildStubClientScreens } from './build-stub-client-screens';

// The overlay's session actions over the client a test gives, with the client's real state
// machine and an overlay that only holds its notice; the test stops the machine.
export function createSessionActionsHarness(client: Pick<DaemonClient, 'sendRequest'>) {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  const overlay: Pick<OverlayScreen, 'notice' | 'render'> = {
    notice: null,
    render: () => {},
  };

  const actions = createSessionActions({
    service,
    mirror: createFleetMirror(),
    overlay,
    getClient: () => client,
    getMode: () => service.getSnapshot().value.mode,
    attach: () => Promise.resolve(),
    sendQuiet: () => Promise.resolve(),
    ptyRows: () => 24,
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
