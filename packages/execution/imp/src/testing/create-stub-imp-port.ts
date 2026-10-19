import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils';
import { buildImpdRefusal } from '../build-impd-refusal';
import type {
  ColdBootCause,
  ImpCommand,
  ImpCommandResult,
  ImpCreateSpec,
  ImpForwardEnd,
  ImpIdentity,
  ImpLease,
  ImpPort,
  ImpRelayConnection,
  ImpReverseForward,
  ImpSecret,
  ImpSecretRule,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionRequest,
  ImpState,
  ImpView,
} from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdExecRefusal, ImpdOutput } from '../impd-contract';
import { MIN_IMPD_VERSION } from '../min-impd-version';
import { requireImpdVersion } from '../require-impd-version';
import { buildNotFound } from './build-not-found';
import { StubImpCommands } from './stub-imp-commands';
import type { StubCommandHold } from './stub-imp-commands';
import { StubImpFleet } from './stub-imp-fleet';
import { StubImpForwards } from './stub-imp-forwards';
import { StubImpLeases } from './stub-imp-leases';
import { StubImpSecrets } from './stub-imp-secrets';
import { StubImpSessions } from './stub-imp-sessions';
import { tryKill } from './try-kill';

// Must be created inside a test, since the test's end kills every process and
// forward the stand-in holds. A sleeping imp SIGSTOPs its processes, so a
// memory wake keeps each process and its generation.
export function createStubImpPort(
  principal = 'token:atc',
  now: () => number = Date.now,
  report: (line: string) => void = (line) => {
    console.error(line);
  },
): StubImpPort {
  return new StubImpPort(principal, now, report);
}

class StubImpPort implements ImpPort {
  // Every port call, in order, as `<call> <imp> [<detail>]`.
  readonly calls: string[] = [];

  // Every session request the port received, in order.
  readonly sessionRequests: ImpSessionRequest[] = [];

  // The spec of every imp create the port received, in order.
  readonly createSpecs: ImpCreateSpec[] = [];

  // The version impd reports.
  version: string = MIN_IMPD_VERSION;

  // Where the port keeps each imp's read-only files, one folder per imp
  // name; null stands for an imp agent from before them.
  readOnlyFilesDir: string | null = null;

  // What a session's agent carries: `none` replays on every connection and
  // ignores resumes.
  continuity: 'offsets' | 'none' = 'offsets';

  // How many bytes before the asked offset an exact resume starts, as
  // impd's at-least-once delivery allows.
  resumeOverlap = 0;

  // Version checks still to fail as an unreachable impd before they answer.
  private versionFailures = 0;

  // Version checks that failed as an unreachable impd.
  private failedVersionChecks = 0;

  private readonly fleet: StubImpFleet;

  private readonly secrets: StubImpSecrets;

  private readonly leases: StubImpLeases;

  private readonly commands: StubImpCommands;

  private readonly forwards: StubImpForwards;

  private readonly sessions: StubImpSessions;

  constructor(principal: string, now: () => number, report: (line: string) => void) {
    const calls = this.calls;

    this.fleet = new StubImpFleet({ principal, now, calls, createSpecs: this.createSpecs });
    this.secrets = new StubImpSecrets({ calls, fleet: this.fleet });
    this.leases = new StubImpLeases({ calls, fleet: this.fleet });
    this.commands = new StubImpCommands({ calls, imps: this.fleet.imps, report });
    this.forwards = new StubImpForwards({ calls });

    this.sessions = new StubImpSessions({
      calls,
      sessionRequests: this.sessionRequests,
      context: { fleet: this.fleet, commands: this.commands, settings: this },
    });
  }

  verifyVersion(): Promise<void> {
    this.calls.push('system.info');

    if (this.versionFailures > 0) {
      this.versionFailures -= 1;
      this.failedVersionChecks += 1;

      return Promise.reject(new ImpPortError('UNREACHABLE', 'impd did not answer'));
    }

    const info: Pick<ImpdOutput<'system.info'>, 'version'> = { version: this.version };

    return new Promise((resolve) => {
      requireImpdVersion(info.version);
      resolve();
    });
  }

  readIdentity(): Promise<ImpIdentity> {
    return this.secrets.readIdentity();
  }

  readSecrets(): Promise<readonly ImpSecret[]> {
    return this.secrets.readSecrets();
  }

  readGrants(name: string): Promise<readonly string[]> {
    return this.secrets.readGrants(name);
  }

  createGrant(name: string, secret: string): Promise<void> {
    return this.secrets.createGrant(name, secret);
  }

  removeGrant(name: string, secret: string): Promise<boolean> {
    return this.secrets.removeGrant(name, secret);
  }

  readImp(name: string): Promise<ImpView | null> {
    return this.fleet.readImp(name);
  }

  createImp(spec: ImpCreateSpec): Promise<ImpView> {
    return this.fleet.createImp(spec);
  }

  acquireLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    return this.leases.acquireLease(name, label, ttlSeconds);
  }

  renewLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    return this.leases.renewLease(name, label, ttlSeconds);
  }

  releaseLease(name: string, label: string): Promise<boolean> {
    return this.leases.releaseLease(name, label);
  }

  suspendImp(name: string): Promise<void> {
    return this.fleet.suspendImp(name);
  }

  destroyImp(name: string): Promise<void> {
    return this.fleet.destroyImp(name);
  }

  openSession(
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
    gate?: () => boolean,
  ): ImpSessionConnection {
    return this.sessions.openSession(request, handlers, gate);
  }

  // Replaces the file through a rename, at mode 0444, as impd's agent does.
  async writeReadOnlyFile(name: string, path: string, content: string): Promise<string> {
    this.calls.push(`files.write ${name} ${path}`);

    if (!this.fleet.imps.has(name)) {
      throw buildNotFound('files.write', name);
    }

    if (this.readOnlyFilesDir === null) {
      throw buildImpdRefusal(
        'files.write',
        { code: 'AGENT_OUTDATED' },
        "the imp's agent has no read-only files yet",
      );
    }

    const target = posix.join(this.readOnlyFilesDir, name, path);
    const staged = posix.join(posix.dirname(target), `.${posix.basename(target)}.${randomUUID()}`);

    await mkdir(posix.dirname(target), { recursive: true });
    await writeFile(staged, content, { mode: 0o444, flag: 'wx' });
    await rename(staged, target);

    const written: ImpdOutput<'files.write'> = { path: target };

    return written.path;
  }

  runCommand(name: string, command: ImpCommand): Promise<ImpCommandResult> {
    return this.commands.runCommand(name, command);
  }

  openReverseForward(
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ): ImpReverseForward {
    return this.forwards.openReverseForward(name, guestPath, onConnection);
  }

  setIdentity(identity: ImpIdentity): void {
    this.secrets.setIdentity(identity);
  }

  createSecret(
    name: string,
    kind: ImpSecret['kind'],
    rules: readonly ImpSecretRule[],
    oauth?: ImpSecret['oauth'],
  ): void {
    this.secrets.createSecret(name, kind, rules, oauth);
  }

  updateSecret(name: string, rules: readonly ImpSecretRule[]): void {
    this.secrets.updateSecret(name, rules);
  }

  removeSecret(name: string): void {
    this.secrets.removeSecret(name);
  }

  acquireOtherLease(name: string, principal: string, label: string, ttlSeconds: number): void {
    this.leases.acquireOtherLease(name, principal, label, ttlSeconds);
  }

  suspendWithForce(name: string): void {
    this.fleet.suspendWithForce(name);
  }

  killProcess(name: string, session: string): void {
    this.fleet.killProcess(name, session);
  }

  bootImpCold(name: string, cause: ColdBootCause): void {
    this.fleet.bootImpCold(name, cause);
  }

  stopConnection(name: string, session: string, closeCode: number): void {
    this.fleet.stopConnection(name, session, closeCode);
  }

  stopRelays(): void {
    this.forwards.stopRelays();
  }

  stopForwards(end: Exclude<ImpForwardEnd, { kind: 'stopped' }>): void {
    this.forwards.stopForwards(end);
  }

  startRelayRefusal(): void {
    this.forwards.startRelayRefusal();
  }

  stopRelayRefusal(): void {
    this.forwards.stopRelayRefusal();
  }

  startBrokerFailure(): void {
    this.sessions.startBrokerFailure();
  }

  stopBrokerFailure(): void {
    this.sessions.stopBrokerFailure();
  }

  startGuestByteDrop(): void {
    this.forwards.startGuestByteDrop();
  }

  stopGuestByteDrop(): void {
    this.forwards.stopGuestByteDrop();
  }

  countDroppedGuestBytes(): number {
    return this.forwards.countDroppedGuestBytes();
  }

  startAnswerHold(): void {
    this.sessions.startAnswerHold();
  }

  countHeldAnswers(): number {
    return this.sessions.countHeldAnswers();
  }

  stopAnswerHold(): void {
    this.sessions.stopAnswerHold();
  }

  setAcquireFailure(skip: number, code: ImpdBareRefusalCode<'leases.acquire'>): void {
    this.leases.setAcquireFailure(skip, code);
  }

  setSessionDrops(count: number, closeCode: number): void {
    this.sessions.setSessionDrops(count, closeCode);
  }

  setOpenFailures(count: number): void {
    this.sessions.setOpenFailures(count);
  }

  setUpgradeFailures(count: number): void {
    this.sessions.setUpgradeFailures(count);
  }

  setExecCheckFailures(count: number): void {
    this.sessions.setExecCheckFailures(count);
  }

  countFailedExecChecks(): number {
    return this.sessions.countFailedExecChecks();
  }

  startUpgradeHold(): void {
    this.sessions.startUpgradeHold();
  }

  countHeldUpgrades(): number {
    return this.sessions.countHeldUpgrades();
  }

  stopUpgradeHold(): void {
    this.sessions.stopUpgradeHold();
  }

  subscribeToLeaseAcquires(listener: (name: string, label: string) => void): () => void {
    return this.leases.subscribeToLeaseAcquires(listener);
  }

  startLeaseHold(): void {
    this.leases.startLeaseHold();
  }

  countHeldLeases(): number {
    return this.leases.countHeldLeases();
  }

  stopLeaseHold(): void {
    this.leases.stopLeaseHold();
  }

  startReleaseHold(): void {
    this.leases.startReleaseHold();
  }

  countHeldReleases(): number {
    return this.leases.countHeldReleases();
  }

  stopReleaseHold(): void {
    this.leases.stopReleaseHold();
  }

  startDestroyHold(): void {
    this.fleet.startDestroyHold();
  }

  countHeldDestroys(): number {
    return this.fleet.countHeldDestroys();
  }

  stopDestroyHold(): void {
    this.fleet.stopDestroyHold();
  }

  setHomeDir(dir: string): void {
    this.commands.setHomeDir(dir);
  }

  setGuestPath(path: string): void {
    this.commands.setGuestPath(path);
  }

  startCommandHold(match: string): StubCommandHold {
    return this.commands.startCommandHold(match);
  }

  countHeldCommands(): number {
    return this.commands.countHeldCommands();
  }

  stopCommandHold(): void {
    this.commands.stopCommandHold();
  }

  setCommandFailure(match: string | null): void {
    this.commands.setCommandFailure(match);
  }

  setDestroyFailure(code: ImpdBareRefusalCode<'imps.destroy'> | null): void {
    this.fleet.setDestroyFailure(code);
  }

  setGrantRemovalFailure(code: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null): void {
    this.secrets.setGrantRemovalFailure(code);
  }

  setVersionFailures(count: number): void {
    this.versionFailures = count;
  }

  // How many version checks failed as an unreachable impd.
  countFailedVersionChecks(): number {
    return this.failedVersionChecks;
  }

  setNextSessionFailure(refusal: ImpdExecRefusal, message?: string): void {
    this.sessions.setNextSessionFailure(refusal, message);
  }

  setNextMalformedSessionFailure(code: string, data: unknown): void {
    this.sessions.setNextMalformedSessionFailure(code, data);
  }

  findState(name: string): ImpState | null {
    return this.fleet.findState(name);
  }

  collectImpNames(): string[] {
    return this.fleet.collectImpNames();
  }

  getBootID(name: string): string {
    return this.fleet.getBootID(name);
  }

  getGeneration(name: string, session: string): string {
    return this.fleet.getGeneration(name, session);
  }

  getProcessArgv(name: string, session: string): readonly string[] {
    return this.fleet.getProcessArgv(name, session);
  }

  findUndeliveredExit(name: string, session: string): { readonly code: number | null } | null {
    return this.fleet.findUndeliveredExit(name, session);
  }

  getEnd(name: string, session: string): number {
    return this.fleet.getEnd(name, session);
  }

  // Runs once the current test finishes, or sooner when called, and only once.
  readonly stop: () => Promise<void> = registerTestCleanup(async () => {
    const commands = this.commands.kill();

    for (const imp of this.fleet.imps.values()) {
      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
        tryKill(proc.pty, 'SIGKILL');
      }
    }

    this.forwards.stop();
    this.fleet.imps.clear();

    await Promise.all(commands.map((command) => command.exited));
  });
}
