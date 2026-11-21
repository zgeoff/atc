import type { DaemonClient } from '@atc/protocol/client';
import { createActor } from 'xstate';
import { buildClientMachine } from '../client/build-client-machine';
import { createSessionActions } from '../client/create-session-actions';
import { createFleetMirror } from '../fleet/create-fleet-mirror';
import type { SessionKey } from '../fleet/session-key';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import { buildStubClientScreens } from './build-stub-client-screens';

// The actions run from the open session list, as the list's keys send them.
export function createSessionActionsHarness(client: Pick<DaemonClient, 'sendRequest'>) {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();
  service.send({ type: 'OVERLAY' });

  const overlay: Pick<OverlayScreen, 'notice' | 'render'> = {
    notice: null,
    render: () => {},
  };

  const homeNotices: string[] = [];
  let focusedKey: SessionKey | null = null;

  const actions = createSessionActions({
    service,
    mirror: createFleetMirror(null),
    overlay,
    links: { clientFor: () => client, stateOf: () => ({ kind: 'up' }) },
    getMode: () => service.getSnapshot().value.mode,
    attach: () => Promise.resolve(),
    ptyRows: () => 24,
    findFocusedKey: () => focusedKey,
    reportFailure: () => {},
    showHomeNotice: (text) => {
      homeNotices.push(text);
    },
  });

  return {
    service,
    overlay,
    actions,
    homeNotices,
    focus: (key: SessionKey | null) => {
      focusedKey = key;
    },
    stop: () => {
      service.stop();
    },
  };
}
