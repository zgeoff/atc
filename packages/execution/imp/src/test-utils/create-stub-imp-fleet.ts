import { randomUUID } from 'node:crypto';
import { buildImpdRefusal } from '../build-impd-refusal';
import type { ColdBootCause, ImpCreateSpec, ImpState, ImpView } from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdOutput } from '../impd-contract';
import { toImpView } from '../to-imp-view';
import { buildImpdLease } from './build-impd-lease';
import { buildNotFound } from './build-not-found';
import type { StubImp } from './stub-imp';
import { tryKill } from './try-kill';

// The imps the stand-in holds, and the moves between their states: create,
// sleep, wake, cold boot, and destroy.
export interface StubImpFleet {
  readonly imps: Map<string, StubImp>;

  readonly principal: string;

  // The time in epoch milliseconds that leases expire against.
  readonly now: () => number;

  readonly readImp: (name: string) => Promise<ImpView | null>;
  readonly createImp: (spec: ImpCreateSpec) => Promise<ImpView>;
  readonly suspendImp: (name: string) => Promise<void>;
  readonly destroyImp: (name: string) => Promise<void>;
  readonly suspendWithForce: (name: string) => void;
  readonly killProcess: (name: string, session: string) => void;
  readonly bootImpCold: (name: string, cause: ColdBootCause) => void;

  // impd closes with 1011 when it drops a send under backpressure.
  readonly stopConnection: (name: string, session: string, closeCode: number) => void;

  readonly startDestroyHold: () => void;

  // How many imp destroys wait for the destroy hold to stop.
  readonly countHeldDestroys: () => number;

  readonly stopDestroyHold: () => void;
  readonly setDestroyFailure: (code: ImpdBareRefusalCode<'imps.destroy'> | null) => void;

  // The state an imp is in, or null when it does not exist.
  readonly findState: (name: string) => ImpState | null;

  // The names of the imps the stub holds.
  readonly collectImpNames: () => string[];

  // The boot an imp runs in.
  readonly getBootID: (name: string) => string;

  // The generation running under a session name.
  readonly getGeneration: (name: string, session: string) => string;

  // The command line of the process running under a session name.
  readonly getProcessArgv: (name: string, session: string) => readonly string[];

  // Null while the process runs and once an attach has delivered the exit.
  readonly findUndeliveredExit: (
    name: string,
    session: string,
  ) => { readonly code: number | null } | null;

  // The offset after the last byte a session's running generation wrote.
  readonly getEnd: (name: string, session: string) => number;

  readonly getImp: (name: string) => StubImp;

  // A sleeping imp wakes from memory with every process as it was; a
  // stopped one boots cold.
  readonly updateAwake: (imp: StubImp) => void;
}

interface StubImpFleetOptions {
  readonly principal: string;
  readonly now: () => number;
  readonly calls: string[];
  readonly createSpecs: ImpCreateSpec[];
}

export function createStubImpFleet(deps: StubImpFleetOptions): StubImpFleet {
  const imps = new Map<string, StubImp>();

  const principal = deps.principal;
  const now = deps.now;

  // The imp destroys wait for this hold to end, while one is held.
  let destroyHold: PromiseWithResolvers<void> | null = null;
  let heldDestroys = 0;

  // impd's code for every imp destroy while destroys fail, or null.
  let destroyFailure: ImpdBareRefusalCode<'imps.destroy'> | null = null;
  const calls = deps.calls;
  const createSpecs = deps.createSpecs;

  const getImp = (name: string): StubImp => {
    const imp = imps.get(name);

    if (imp === undefined) {
      throw new Error(`no imp ${name}`);
    }

    return imp;
  };

  const applyDestroy = (name: string): Promise<void> => {
    if (destroyFailure !== null) {
      return Promise.reject(new ImpPortError(destroyFailure, `impd could not destroy ${name}`));
    }

    const imp = imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('imps.destroy', name));
    }

    for (const subprocess of imp.sessions.values()) {
      subprocess.connection?.stop({ kind: 'closed', reason: 'imp destroyed', closeCode: 1000 });
      subprocess.connection = null;
      subprocess.exited ??= { code: null };

      tryKill(subprocess.pty, 'SIGKILL');
    }

    imps.delete(name);

    return Promise.resolve();
  };

  const waitForDestroy = async (name: string): Promise<void> => {
    heldDestroys += 1;

    await destroyHold?.promise;

    heldDestroys -= 1;

    return applyDestroy(name);
  };

  // An imp as impd lists it to the port's principal: its own leases in
  // full, and a count of the other principals that hold one.
  const buildImpdImp = (
    imp: StubImp,
  ): Pick<ImpdOutput<'imps.get'>, 'id' | 'name' | 'state' | 'leases'> => {
    const live = [...imp.leases.values()].filter((lease) => lease.until > now());
    const own = live.filter((lease) => lease.principal === principal);
    const others = live.filter((lease) => lease.principal !== principal);

    return {
      id: imp.id,
      name: imp.name,
      state: imp.state,
      leases: {
        leases: own.map((lease) =>
          buildImpdLease(imp.name, lease.principal, lease.label, lease.until),
        ),
        otherCount: new Set(others.map((lease) => lease.principal)).size,
      },
    };
  };

  const bootCold = (imp: StubImp, cause: ColdBootCause): void => {
    for (const subprocess of imp.sessions.values()) {
      subprocess.connection?.stop({ kind: 'detached', reason: 'lost', offset: subprocess.end });
      subprocess.ended = true;

      tryKill(subprocess.pty, 'SIGCONT');
      tryKill(subprocess.pty, 'SIGKILL');
    }

    imp.sessions.clear();
    imp.previous.clear();

    imp.state = 'running';
    imp.bootId = randomUUID();

    imp.coldBoots = [
      { bootId: imp.bootId, cause, at: new Date(now()).toISOString() },
      ...imp.coldBoots,
    ].slice(0, 4);
  };

  return {
    imps,

    principal,

    now,

    readImp: (name) => {
      calls.push(`imps.get ${name}`);

      const imp = imps.get(name);
      const view = imp === undefined ? null : toImpView(buildImpdImp(imp));

      return Promise.resolve(view);
    },

    createImp: (spec) => {
      calls.push(`imps.create ${spec.name}`);
      createSpecs.push(spec);

      if (imps.has(spec.name)) {
        return Promise.reject(
          buildImpdRefusal(
            'imps.create',
            {
              code: 'CONFLICT',
              data: {
                kind: 'imp',
                name: spec.name,
              },
            },
            `imp ${spec.name} exists`,
          ),
        );
      }

      const imp: StubImp = {
        id: randomUUID(),
        name: spec.name,
        state: 'stopped',
        bootId: '',
        coldBoots: [],
        leases: new Map(),
        sessions: new Map(),
        previous: new Map(),
        grants: new Set(),
      };

      imps.set(spec.name, imp);

      bootCold(imp, 'start');

      return Promise.resolve(toImpView(buildImpdImp(imp)));
    },

    suspendImp: (name) => {
      calls.push(`imps.sleep ${name}`);

      const imp = imps.get(name);

      if (imp === undefined) {
        return Promise.reject(buildNotFound('imps.sleep', name));
      }

      const live = [...imp.leases.values()].filter((lease) => lease.until > now());

      if (imp.state === 'running' && live.length > 0) {
        const own = live.filter((lease) => lease.principal === principal);
        const others = live.filter((lease) => lease.principal !== principal);

        const otherPrincipals = new Set(others.map((lease) => lease.principal));

        return Promise.reject(
          buildImpdRefusal(
            'imps.sleep',
            {
              code: 'LEASED',
              data: {
                leases: own.map((lease) =>
                  buildImpdLease(name, lease.principal, lease.label, lease.until),
                ),
                otherCount: otherPrincipals.size,
              },
            },
            'the imp is leased',
          ),
        );
      }

      updateAsleep(imp);

      return Promise.resolve();
    },

    destroyImp: (name) => {
      calls.push(`imps.destroy ${name}`);

      return destroyHold === null ? applyDestroy(name) : waitForDestroy(name);
    },

    suspendWithForce: (name) => {
      const imp = getImp(name);

      imp.leases.clear();

      updateAsleep(imp);
    },

    killProcess: (name, session) => {
      const subprocess = getImp(name).sessions.get(session);

      if (subprocess === undefined) {
        throw new Error(`no session ${session} on imp ${name}`);
      }

      tryKill(subprocess.pty, 'SIGCONT');
      tryKill(subprocess.pty, 'SIGKILL');
    },

    bootImpCold: (name, cause) => {
      bootCold(getImp(name), cause);
    },

    stopConnection: (name, session, closeCode) => {
      const subprocess = getImp(name).sessions.get(session);

      subprocess?.connection?.stop({ kind: 'closed', reason: `code ${closeCode}`, closeCode });
    },

    startDestroyHold: () => {
      destroyHold ??= Promise.withResolvers<void>();
    },

    countHeldDestroys: () => heldDestroys,

    stopDestroyHold: () => {
      destroyHold?.resolve();
      destroyHold = null;
    },

    setDestroyFailure: (code) => {
      destroyFailure = code;
    },

    findState: (name) => imps.get(name)?.state ?? null,

    collectImpNames: () => [...imps.keys()],

    getBootID: (name) => getImp(name).bootId,

    getGeneration: (name, session) => {
      const subprocess = getImp(name).sessions.get(session);

      if (subprocess === undefined) {
        throw new Error(`no session ${session} on imp ${name}`);
      }

      return subprocess.generation;
    },

    getProcessArgv: (name, session) => {
      const subprocess = getImp(name).sessions.get(session);

      if (subprocess === undefined) {
        throw new Error(`no session ${session} on imp ${name}`);
      }

      return subprocess.argv;
    },

    findUndeliveredExit: (name, session) => imps.get(name)?.sessions.get(session)?.exited ?? null,

    getEnd: (name, session) => {
      const subprocess = getImp(name).sessions.get(session);

      if (subprocess === undefined) {
        throw new Error(`no session ${session} on imp ${name}`);
      }

      return subprocess.end;
    },

    getImp,

    updateAwake: (imp) => {
      if (imp.state === 'sleeping') {
        imp.state = 'running';

        for (const subprocess of imp.sessions.values()) {
          tryKill(subprocess.pty, 'SIGCONT');
        }
      } else if (imp.state !== 'running') {
        bootCold(imp, 'start');
      }
    },
  };
}

function updateAsleep(imp: StubImp): void {
  if (imp.state !== 'running') {
    return;
  }

  imp.state = 'sleeping';

  for (const subprocess of imp.sessions.values()) {
    tryKill(subprocess.pty, 'SIGSTOP');
    subprocess.connection?.stop({ kind: 'detached', reason: 'lost', offset: subprocess.end });
  }
}
