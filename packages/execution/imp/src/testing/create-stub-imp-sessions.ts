import type {
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
} from '../imp-port';
import type { ImpdExecRefusal } from '../impd-contract';
import { answerStubSession } from './answer-stub-session';
import type { StubSessionContext, StubSessionFaults } from './answer-stub-session';
import type { StubConnection } from './stub-imp';
import { tryKill } from './try-kill';

// The session connections the port opens to impd: how each opens and sends
// its request, and the holds and failures a test puts on the way there.
export interface StubImpSessions {
  readonly openSession: (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ) => ImpSessionConnection;

  readonly startBrokerFailure: () => void;
  readonly stopBrokerFailure: () => void;
  readonly startAnswerHold: () => void;

  // How many session answers wait for the answer hold to stop.
  readonly countHeldAnswers: () => number;

  readonly stopAnswerHold: () => void;
  readonly setSessionDrops: (count: number, closeCode: number) => void;

  // The open throws before it returns a connection.
  readonly setOpenFailures: (count: number) => void;

  // Each connection ends unreachable without opening.
  readonly setUpgradeFailures: (count: number) => void;

  // impd's client checks capabilities before a start that requires the broker
  // or drops CAP_SYS_ADMIN; a check that times out ends the start unreachable
  // with nothing sent.
  readonly setExecCheckFailures: (count: number) => void;

  // How many capability checks timed out.
  readonly countFailedExecChecks: () => number;

  readonly startUpgradeHold: () => void;

  // How many connections wait for the upgrade hold to stop.
  readonly countHeldUpgrades: () => number;

  readonly stopUpgradeHold: () => void;
  readonly setNextSessionFailure: (refusal: ImpdExecRefusal, message?: string) => void;

  // The one answer the contract does not type, for a test of how the daemon
  // reads a refusal it cannot trust.
  readonly setNextMalformedSessionFailure: (code: string, data: unknown) => void;
}

interface StubImpSessionsOptions {
  readonly calls: string[];
  readonly sessionRequests: ImpSessionRequest[];
  readonly context: Omit<StubSessionContext, 'faults'>;
}

export function createStubImpSessions(deps: StubImpSessionsOptions): StubImpSessions {
  // Session answers held back while a test lets output pile up, or null
  // when answers go out at once.
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

  // Session connections still to fail their upgrade, ending unreachable
  // before they open and before any gate runs.
  let upgradeFailures = 0;

  // Capability checks still to time out, each ending its start unreachable
  // once the connection opens, before any gate runs.
  let execCheckFailures = 0;

  // Capability checks that timed out.
  let failedExecChecks = 0;

  // The connections still opening while upgrades are held, each sending
  // its request once it opens; null while connections open at once.
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

      // The request reaches impd once the connection opens, after impd's
      // client checks the features a start needs and the gate lets it go; a
      // check that times out or a closed gate sends nothing.
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

        // impd answers over the network: nothing reaches the caller before
        // openSession returns.
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

// A gate that throws keeps the request from going out, as a closed one does.
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
