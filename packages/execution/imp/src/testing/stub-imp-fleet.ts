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

interface StubImpFleetOptions {
  readonly principal: string;
  readonly now: () => number;
  readonly calls: string[];
  readonly createSpecs: ImpCreateSpec[];
}

// The imps the stand-in holds, and the moves between their states: create,
// sleep, wake, cold boot, and destroy.
export class StubImpFleet {
  readonly imps = new Map<string, StubImp>();

  readonly principal: string;

  // The time in epoch milliseconds that leases expire against.
  readonly now: () => number;

  // The imp destroys wait for this hold to end, while one is held.
  private destroyHold: PromiseWithResolvers<void> | null = null;

  private heldDestroys = 0;

  // impd's code for every imp destroy while destroys fail, or null.
  private destroyFailure: ImpdBareRefusalCode<'imps.destroy'> | null = null;

  private readonly calls: string[];

  private readonly createSpecs: ImpCreateSpec[];

  constructor(deps: StubImpFleetOptions) {
    this.principal = deps.principal;
    this.now = deps.now;
    this.calls = deps.calls;
    this.createSpecs = deps.createSpecs;
  }

  readImp(name: string): Promise<ImpView | null> {
    this.calls.push(`imps.get ${name}`);

    const imp = this.imps.get(name);
    const view = imp === undefined ? null : toImpView(this.buildImpdImp(imp));

    return Promise.resolve(view);
  }

  createImp(spec: ImpCreateSpec): Promise<ImpView> {
    this.calls.push(`imps.create ${spec.name}`);
    this.createSpecs.push(spec);

    if (this.imps.has(spec.name)) {
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

    this.imps.set(spec.name, imp);
    this.bootCold(imp, 'start');

    return Promise.resolve(toImpView(this.buildImpdImp(imp)));
  }

  suspendImp(name: string): Promise<void> {
    this.calls.push(`imps.sleep ${name}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('imps.sleep', name));
    }

    const live = [...imp.leases.values()].filter((lease) => lease.until > this.now());

    if (imp.state === 'running' && live.length > 0) {
      const own = live.filter((lease) => lease.principal === this.principal);
      const others = live.filter((lease) => lease.principal !== this.principal);

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

    this.updateAsleep(imp);

    return Promise.resolve();
  }

  destroyImp(name: string): Promise<void> {
    this.calls.push(`imps.destroy ${name}`);

    return this.destroyHold === null ? this.applyDestroy(name) : this.waitForDestroy(name);
  }

  suspendWithForce(name: string): void {
    const imp = this.getImp(name);

    imp.leases.clear();
    this.updateAsleep(imp);
  }

  killProcess(name: string, session: string): void {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    tryKill(proc.pty, 'SIGCONT');
    tryKill(proc.pty, 'SIGKILL');
  }

  bootImpCold(name: string, cause: ColdBootCause): void {
    this.bootCold(this.getImp(name), cause);
  }

  // impd closes with 1011 when it drops a send under backpressure.
  stopConnection(name: string, session: string, closeCode: number): void {
    const proc = this.getImp(name).sessions.get(session);

    proc?.connection?.stop({ kind: 'closed', reason: `code ${closeCode}`, closeCode });
  }

  startDestroyHold(): void {
    this.destroyHold ??= Promise.withResolvers<void>();
  }

  // How many imp destroys wait for the destroy hold to stop.
  countHeldDestroys(): number {
    return this.heldDestroys;
  }

  stopDestroyHold(): void {
    this.destroyHold?.resolve();
    this.destroyHold = null;
  }

  setDestroyFailure(code: ImpdBareRefusalCode<'imps.destroy'> | null): void {
    this.destroyFailure = code;
  }

  // The state an imp is in, or null when it does not exist.
  findState(name: string): ImpState | null {
    return this.imps.get(name)?.state ?? null;
  }

  // The names of the imps the stub holds.
  collectImpNames(): string[] {
    return [...this.imps.keys()];
  }

  // The boot an imp runs in.
  getBootID(name: string): string {
    return this.getImp(name).bootId;
  }

  // The generation running under a session name.
  getGeneration(name: string, session: string): string {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.generation;
  }

  // The command line of the process running under a session name.
  getProcessArgv(name: string, session: string): readonly string[] {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.argv;
  }

  // Null while the process runs and once an attach has delivered the exit.
  findUndeliveredExit(name: string, session: string): { readonly code: number | null } | null {
    return this.imps.get(name)?.sessions.get(session)?.exited ?? null;
  }

  // The offset after the last byte a session's running generation wrote.
  getEnd(name: string, session: string): number {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.end;
  }

  getImp(name: string): StubImp {
    const imp = this.imps.get(name);

    if (imp === undefined) {
      throw new Error(`no imp ${name}`);
    }

    return imp;
  }

  // A sleeping imp wakes from memory with every process as it was; a
  // stopped one boots cold.
  updateAwake(imp: StubImp): void {
    if (imp.state === 'sleeping') {
      imp.state = 'running';

      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
      }
    } else if (imp.state !== 'running') {
      this.bootCold(imp, 'start');
    }
  }

  private async waitForDestroy(name: string): Promise<void> {
    this.heldDestroys += 1;

    await this.destroyHold?.promise;

    this.heldDestroys -= 1;

    return this.applyDestroy(name);
  }

  private applyDestroy(name: string): Promise<void> {
    if (this.destroyFailure !== null) {
      return Promise.reject(
        new ImpPortError(this.destroyFailure, `impd could not destroy ${name}`),
      );
    }

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound('imps.destroy', name));
    }

    for (const proc of imp.sessions.values()) {
      proc.connection?.stop({ kind: 'closed', reason: 'imp destroyed', closeCode: 1000 });
      proc.connection = null;
      proc.exited ??= { code: null };

      tryKill(proc.pty, 'SIGKILL');
    }

    this.imps.delete(name);

    return Promise.resolve();
  }

  // An imp as impd lists it to the port's principal: its own leases in
  // full, and a count of the other principals that hold one.
  private buildImpdImp(
    imp: StubImp,
  ): Pick<ImpdOutput<'imps.get'>, 'id' | 'name' | 'state' | 'leases'> {
    const live = [...imp.leases.values()].filter((lease) => lease.until > this.now());
    const own = live.filter((lease) => lease.principal === this.principal);
    const others = live.filter((lease) => lease.principal !== this.principal);

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
  }

  private updateAsleep(imp: StubImp): void {
    if (imp.state !== 'running') {
      return;
    }

    imp.state = 'sleeping';

    for (const proc of imp.sessions.values()) {
      tryKill(proc.pty, 'SIGSTOP');
      proc.connection?.stop({ kind: 'detached', reason: 'lost', offset: proc.end });
    }
  }

  private bootCold(imp: StubImp, cause: ColdBootCause): void {
    for (const proc of imp.sessions.values()) {
      proc.connection?.stop({ kind: 'detached', reason: 'lost', offset: proc.end });
      proc.ended = true;

      tryKill(proc.pty, 'SIGCONT');
      tryKill(proc.pty, 'SIGKILL');
    }

    imp.sessions.clear();
    imp.previous.clear();

    imp.state = 'running';
    imp.bootId = randomUUID();

    imp.coldBoots = [
      { bootId: imp.bootId, cause, at: new Date(this.now()).toISOString() },
      ...imp.coldBoots,
    ].slice(0, 4);
  }
}
