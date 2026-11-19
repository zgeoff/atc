import type { ImpdExecRefusal } from '../impd/impd-procedure';
import type {
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
} from '../port/imp-port';
import { answerStubSession } from './answer-stub-session';
import type { StubSessionContext, StubSessionFaults } from './answer-stub-session';
import type { StubConnection } from './stub-imp';
import { tryKill } from './try-kill';

export interface StubImpSessions {
  readonly openSession: (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ) => ImpSessionConnection;

  readonly startBrokerFailure: () => void;
  readonly stopBrokerFailure: () => void;
  readonly startAnswerHold: () => void;

  readonly countHeldAnswers: () => number;

  readonly stopAnswerHold: () => void;
  readonly setSessionDrops: (count: number, closeCode: number) => void;

  readonly setOpenFailures: (count: number) => void;

  readonly setUpgradeFailures: (count: number) => void;

  // impd's client checks capabilities before a start that requires the broker
  // or drops CAP_SYS_ADMIN; a check that times out ends the start unreachable
  // with nothing sent.
  readonly setExecCheckFailures: (count: number) => void;

  readonly countFailedExecChecks: () => number;

  readonly startUpgradeHold: () => void;

  readonly countHeldUpgrades: () => number;

  readonly stopUpgradeHold: () => void;
  readonly setNextSessionFailure: (refusal: ImpdExecRefusal, message?: string) => void;

  readonly setNextMalformedSessionFailure: (code: string, data: unknown) => void;
}

interface StubImpSessionsOptions {
  readonly calls: string[];
  readonly sessionRequests: ImpSessionRequest[];
  readonly context: Omit<StubSessionContext, 'faults'>;
}

export function createStubImpSessions(deps: StubImpSessionsOptions): StubImpSessions {
  let held: (() => void)[] | null = null;

  const faults: StubSessionFaults = {
    drops: { count: 0, closeCode: 1011 },
    nextMalformedFailure: null,
    nextFailure: null,
    brokerFailing: false,
  };

  // Session connections whose opening still throws before it returns, as
  // an invalid authorization header makes the socket's constructor throw.
  let openFailures = 0;
  let upgradeFailures = 0;
  let execCheckFailures = 0;
  let failedExecChecks = 0;
  let upgrades: (() => void)[] | null = null;
  const calls = deps.calls;
  const sessionRequests = deps.sessionRequests;
  const context: StubSessionContext = { ...deps.context, faults };

  return {
    openSession: (request, handlers, gate) => {
      if (openFailures > 0) {
        openFailures -= 1;
        throw new TypeError('the authorization header is invalid');
      }

      const outcome = Promise.withResolvers<ImpSessionOutcome>();

      const stopConnection = (result: ImpSessionOutcome) => {
        if (connection.finished) {
          return;
        }

        connection.finished = true;

        if (connection.process?.connection === connection) {
          connection.process.connection = null;
        }

        outcome.resolve(result);
      };

      const connection: StubConnection = {
        handlers,
        sent: 0,
        finished: false,
        process: null,
        stop: (result) => {
          stopConnection(result);
        },
        stopMalformed: (result) => {
          stopConnection(result);
        },
      };

      const sendToImpd = () => {
        if (execCheckFailures > 0 && shouldCheckExec(request)) {
          execCheckFailures -= 1;
          failedExecChecks += 1;

          setTimeout(() => {
            connection.stop({
              kind: 'unreachable',
              detail: 'system.info: The operation timed out.',
            });
          }, 0);

          return;
        }

        if (gate !== undefined && !tryPassGate(gate)) {
          connection.stop({ kind: 'closed', reason: 'closed before sending', closeCode: 1000 });

          return;
        }

        calls.push(`exec.${request.kind} ${request.name} ${request.session}`);
        sessionRequests.push(request);

        // Real impd answers over the network, so no reply reaches the caller before the session
        // open call returns. Answer on a later tick to match.
        setTimeout(() => {
          if (held === null) {
            answerStubSession(context, request, connection);
          } else {
            held.push(() => {
              answerStubSession(context, request, connection);
            });
          }
        }, 0);
      };

      if (upgradeFailures > 0) {
        upgradeFailures -= 1;

        setTimeout(() => {
          connection.stop({ kind: 'unreachable', detail: 'the upgrade failed' });
        }, 0);
      } else if (upgrades === null) {
        sendToImpd();
      } else {
        upgrades.push(sendToImpd);
      }

      return {
        outcome: outcome.promise,
        write: (data) => {
          if (!connection.finished && connection.process !== null) {
            connection.process.pty.write(new TextDecoder().decode(data));
          }
        },
        resize: (cols, rows) => {
          if (!connection.finished && connection.process !== null) {
            connection.process.pty.resize(cols, rows);
          }
        },
        sendSignal: (signal) => {
          if (!connection.finished && connection.process !== null) {
            tryKill(connection.process.pty, 'SIGCONT');
            tryKill(connection.process.pty, toSignal(signal));
          }
        },
        close: () => {
          connection.stop({ kind: 'closed', reason: 'closed by the client', closeCode: 1000 });
        },
      };
    },

    startBrokerFailure: () => {
      faults.brokerFailing = true;
    },

    stopBrokerFailure: () => {
      faults.brokerFailing = false;
    },

    startAnswerHold: () => {
      held ??= [];
    },

    countHeldAnswers: () => held?.length ?? 0,

    stopAnswerHold: () => {
      const answers = held ?? [];

      held = null;

      for (const answer of answers) {
        answer();
      }
    },

    setSessionDrops: (count, closeCode) => {
      faults.drops = { count, closeCode };
    },

    setOpenFailures: (count) => {
      openFailures = count;
    },

    setUpgradeFailures: (count) => {
      upgradeFailures = count;
    },

    setExecCheckFailures: (count) => {
      execCheckFailures = count;
    },

    countFailedExecChecks: () => failedExecChecks,

    startUpgradeHold: () => {
      upgrades ??= [];
    },

    countHeldUpgrades: () => upgrades?.length ?? 0,

    stopUpgradeHold: () => {
      const sends = upgrades ?? [];

      upgrades = null;

      for (const send of sends) {
        send();
      }
    },

    setNextSessionFailure: (refusal, message) => {
      faults.nextFailure = { refusal, ...(message === undefined ? {} : { message }) };
    },

    setNextMalformedSessionFailure: (code, data) => {
      faults.nextMalformedFailure = { code, data };
    },
  };
}

// impd's client reads impd's features before a start that requires the
// broker or drops CAP_SYS_ADMIN, and before nothing else.
function shouldCheckExec(request: ImpSessionRequest): boolean {
  return (
    request.kind === 'start' &&
    ((request.require !== undefined && request.require.length > 0) || request.dropSysAdmin === true)
  );
}

function tryPassGate(gate: () => boolean): boolean {
  try {
    return gate();
  } catch {
    return false;
  }
}

function toSignal(name: string): NodeJS.Signals {
  return name === 'SIGKILL' || name === 'SIGTERM' || name === 'SIGINT' ? name : 'SIGHUP';
}
