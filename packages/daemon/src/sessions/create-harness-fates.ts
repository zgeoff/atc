import { collectFateReads, isSleepingSession } from './collect-fate-reads';
import type { FateScope } from './collect-fate-reads';
import type { SessionRegistry } from './create-session-registry';
import { HARNESS_EXIT_TRANSITIONS } from './harness-exit-transitions';
import type { SessionCallbacks } from './session-callbacks';

export interface HarnessFates {
  // Asks each host with sleeping sessions in the scope whether it still holds their harnesses. A
  // lost harness lists as ended and leaves the fleet row as it is; a failed read changes nothing.
  readonly readFates: (scope?: FateScope) => Promise<void>;
}

interface HarnessFatesDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'targets'>;
  readonly callbacks: Pick<SessionCallbacks, 'log' | 'onEvent'>;
}

export function createHarnessFates(deps: HarnessFatesDeps): HarnessFates {
  const registry = deps.registry;
  const callbacks = deps.callbacks;

  return {
    readFates: async (scope = {}) => {
      await Promise.all(
        collectFateReads(registry.sessions, scope).map(async (read) => {
          const provider = registry.targets.get(read.target)?.provider;

          if (provider?.readHarnessFates === undefined) {
            return;
          }

          let fates;

          try {
            fates = await provider.readHarnessFates(
              read.hostKey,
              read.sessions.map((session) => session.id),
            );
          } catch (error) {
            callbacks.log(
              `atc could not read the harness fates of host ${read.hostKey} (${error instanceof Error ? error.message : String(error)})`,
            );

            return;
          }

          // a session revived, killed or forgotten while the read ran keeps what that left
          for (const session of read.sessions) {
            if (
              fates.get(session.id) === 'lost' &&
              isSleepingSession(session) &&
              registry.sessions.includes(session)
            ) {
              session.lastMsg = HARNESS_EXIT_TRANSITIONS.ended.message;

              callbacks.onEvent('state', session);
            }
          }
        }),
      );
    },
  };
}
