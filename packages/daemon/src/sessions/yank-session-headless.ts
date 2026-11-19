import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionRegistry } from './create-session-registry';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';

interface YankSessionHeadlessDeps {
  readonly registry: Pick<SessionRegistry, 'sessions'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

export function yankSessionHeadless(deps: YankSessionHeadlessDeps, id: SessionID): Session | null {
  const session = deps.registry.sessions.find((x) => x.id === id);

  if (!session || session.pty === null || session.agentSessionID === undefined) {
    return null;
  }

  const pty = session.pty;

  session.pty = null;
  session.kind = 'headless';
  session.state = 'running';
  session.lastMsg = 'ejected to headless';

  pty.kill();
  deps.callbacks.onEvent('state', session);
  deps.fleet.emitChange();

  return session;
}
