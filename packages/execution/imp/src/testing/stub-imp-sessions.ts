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

interface StubImpSessionsOptions {
  readonly calls: string[];
  readonly sessionRequests: ImpSessionRequest[];
  readonly context: Omit<StubSessionContext, 'faults'>;
}

// The session connections the port opens to impd: how each opens and sends
// its request, and the holds and failures a test puts on the way there.
export class StubImpSessions {
  // Session answers held back while a test lets output pile up, or null
  // when answers go out at once.
  private held: (() => void)[] | null = null;

  private readonly faults: StubSessionFaults = {
    drops: { count: 0, closeCode: 1011 },
    nextMalformedFailure: null,
    nextFailure: null,
    brokerFailing: false,
  };

  // Session connections whose opening still throws before it returns, as
  // an invalid authorization header makes the socket's constructor throw.
  private openFailures = 0;

  // Session connections still to fail their upgrade, ending unreachable
  // before they open and before any gate runs.
  private upgradeFailures = 0;

  // Capability checks still to time out, each ending its start unreachable
  // once the connection opens, before any gate runs.
  private execCheckFailures = 0;

  // Capability checks that timed out.
  private failedExecChecks = 0;

  // The connections still opening while upgrades are held, each sending
  // its request once it opens; null while connections open at once.
  private upgrades: (() => void)[] | null = null;

  private readonly calls: string[];

  private readonly sessionRequests: ImpSessionRequest[];

  private readonly context: StubSessionContext;

  constructor(deps: StubImpSessionsOptions) {
    this.calls = deps.calls;
    this.sessionRequests = deps.sessionRequests;
    this.context = { ...deps.context, faults: this.faults };
  }

  openSession(
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ): ImpSessionConnection {
    if (this.openFailures > 0) {
      this.openFailures -= 1;
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
      if (this.execCheckFailures > 0 && needsExecCheck(request)) {
        this.execCheckFailures -= 1;
        this.failedExecChecks += 1;

        setTimeout(() => {
          connection.stop({ kind: 'unreachable', detail: 'system.info: The operation timed out.' });
        }, 0);

        return;
      }

      if (gate !== undefined && !tryPassGate(gate)) {
        connection.stop({ kind: 'closed', reason: 'closed before sending', closeCode: 1000 });

        return;
      }

      this.calls.push(`exec.${request.kind} ${request.name} ${request.session}`);
      this.sessionRequests.push(request);

      // impd answers over the network: nothing reaches the caller before
      // openSession returns.
      setTimeout(() => {
        if (this.held === null) {
          answerStubSession(this.context, request, connection);
        } else {
          this.held.push(() => {
            answerStubSession(this.context, request, connection);
          });
        }
      }, 0);
    };

    if (this.upgradeFailures > 0) {
      this.upgradeFailures -= 1;

      setTimeout(() => {
        connection.stop({ kind: 'unreachable', detail: 'the upgrade failed' });
      }, 0);
    } else if (this.upgrades === null) {
      sendToImpd();
    } else {
      this.upgrades.push(sendToImpd);
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
  }

  startBrokerFailure(): void {
    this.faults.brokerFailing = true;
  }

  stopBrokerFailure(): void {
    this.faults.brokerFailing = false;
  }

  startAnswerHold(): void {
    this.held ??= [];
  }

  // How many session answers wait for the answer hold to stop.
  countHeldAnswers(): number {
    return this.held?.length ?? 0;
  }

  stopAnswerHold(): void {
    const held = this.held ?? [];

    this.held = null;

    for (const answer of held) {
      answer();
    }
  }

  setSessionDrops(count: number, closeCode: number): void {
    this.faults.drops = { count, closeCode };
  }

  // The open throws before it returns a connection.
  setOpenFailures(count: number): void {
    this.openFailures = count;
  }

  // Each connection ends unreachable without opening.
  setUpgradeFailures(count: number): void {
    this.upgradeFailures = count;
  }

  // impd's client checks capabilities before a start that requires the broker
  // or drops CAP_SYS_ADMIN; a check that times out ends the start unreachable
  // with nothing sent.
  setExecCheckFailures(count: number): void {
    this.execCheckFailures = count;
  }

  // How many capability checks timed out.
  countFailedExecChecks(): number {
    return this.failedExecChecks;
  }

  startUpgradeHold(): void {
    this.upgrades ??= [];
  }

  // How many connections wait for the upgrade hold to stop.
  countHeldUpgrades(): number {
    return this.upgrades?.length ?? 0;
  }

  stopUpgradeHold(): void {
    const upgrades = this.upgrades ?? [];

    this.upgrades = null;

    for (const send of upgrades) {
      send();
    }
  }

  setNextSessionFailure(refusal: ImpdExecRefusal, message?: string): void {
    this.faults.nextFailure = { refusal, ...(message === undefined ? {} : { message }) };
  }

  // The one answer the contract does not type, for a test of how the daemon
  // reads a refusal it cannot trust.
  setNextMalformedSessionFailure(code: string, data: unknown): void {
    this.faults.nextMalformedFailure = { code, data };
  }
}

// impd's client reads impd's features before a start that requires the
// broker or drops CAP_SYS_ADMIN, and before nothing else.
function needsExecCheck(request: ImpSessionRequest): boolean {
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
