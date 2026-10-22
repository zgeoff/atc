import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils';
import { buildImpdRefusal } from '../build-impd-refusal';
import type {
  ColdBootCause,
  ImpCreateSpec,
  ImpForwardEnd,
  ImpIdentity,
  ImpPort,
  ImpSecret,
  ImpSecretRule,
  ImpSessionRequest,
  ImpState,
} from '../imp-port';
import { ImpPortError } from '../imp-port-error';
import type { ImpdBareRefusalCode, ImpdExecRefusal, ImpdOutput } from '../impd-contract';
import { MIN_IMPD_VERSION } from '../min-impd-version';
import { requireGuestScratchDir } from '../require-guest-scratch-dir';
import { requireImpdVersion } from '../require-impd-version';
import { buildNotFound } from './build-not-found';
import { createStubImpCommands } from './create-stub-imp-commands';
import type { StubCommandHold } from './create-stub-imp-commands';
import { createStubImpFleet } from './create-stub-imp-fleet';
import { createStubImpForwards } from './create-stub-imp-forwards';
import { createStubImpLeases } from './create-stub-imp-leases';
import { createStubImpSecrets } from './create-stub-imp-secrets';
import { createStubImpSessions } from './create-stub-imp-sessions';
import { tryKill } from './try-kill';

interface StubImpPort extends ImpPort {
  // Every port call, in order, as `<call> <imp> [<detail>]`.
  readonly calls: string[];

  // Every session request the port received, in order.
  readonly sessionRequests: ImpSessionRequest[];

  // The spec of every imp create the port received, in order.
  readonly createSpecs: ImpCreateSpec[];

  version: string;

  // The guest scratch folder impd declares; null stands for an impd from
  // before it declared one.
  scratchDir: string | null;

  // Where the port keeps each imp's read-only files, one folder per imp
  // name; null stands for an imp agent from before them.
  readOnlyFilesDir: string | null;

  // What a session's agent carries: `none` replays on every connection and
  // ignores resumes.
  continuity: 'offsets' | 'none';

  // How many bytes before the asked offset an exact resume starts, as
  // impd's at-least-once delivery allows.
  resumeOverlap: number;

  readonly setIdentity: (identity: ImpIdentity) => void;
  readonly createSecret: (
    name: string,
    kind: ImpSecret['kind'],
    rules: readonly ImpSecretRule[],
    oauth?: ImpSecret['oauth'],
  ) => void;
  readonly updateSecret: (name: string, rules: readonly ImpSecretRule[]) => void;
  readonly removeSecret: (name: string) => void;
  readonly acquireOtherLease: (
    name: string,
    principal: string,
    label: string,
    ttlSeconds: number,
  ) => void;
  readonly suspendWithForce: (name: string) => void;
  readonly killProcess: (name: string, session: string) => void;
  readonly bootImpCold: (name: string, cause: ColdBootCause) => void;
  readonly stopConnection: (name: string, session: string, closeCode: number) => void;
  readonly stopRelays: () => void;
  readonly stopForwards: (end: Exclude<ImpForwardEnd, { kind: 'stopped' }>) => void;
  readonly startRelayRefusal: () => void;
  readonly stopRelayRefusal: () => void;
  readonly startBrokerFailure: () => void;
  readonly stopBrokerFailure: () => void;
  readonly startGuestByteDrop: () => void;
  readonly stopGuestByteDrop: () => void;
  readonly countDroppedGuestBytes: () => number;
  readonly startAnswerHold: () => void;
  readonly countHeldAnswers: () => number;
  readonly stopAnswerHold: () => void;
  readonly setAcquireFailure: (skip: number, code: ImpdBareRefusalCode<'leases.acquire'>) => void;
  readonly setSessionDrops: (count: number, closeCode: number) => void;
  readonly setOpenFailures: (count: number) => void;
  readonly setUpgradeFailures: (count: number) => void;
  readonly setExecCheckFailures: (count: number) => void;
  readonly countFailedExecChecks: () => number;
  readonly startUpgradeHold: () => void;
  readonly countHeldUpgrades: () => number;
  readonly stopUpgradeHold: () => void;
  readonly subscribeToLeaseAcquires: (
    listener: (name: string, label: string) => void,
  ) => () => void;
  readonly startLeaseHold: () => void;
  readonly countHeldLeases: () => number;
  readonly stopLeaseHold: () => void;
  readonly startReleaseHold: () => void;
  readonly countHeldReleases: () => number;
  readonly stopReleaseHold: () => void;
  readonly startDestroyHold: () => void;
  readonly countHeldDestroys: () => number;
  readonly stopDestroyHold: () => void;
  readonly setHomeDir: (directory: string) => void;
  readonly setGuestPath: (path: string) => void;
  readonly startCommandHold: (match: string) => StubCommandHold;
  readonly countHeldCommands: () => number;
  readonly stopCommandHold: () => void;
  readonly setCommandFailure: (match: string | null) => void;
  readonly setDestroyFailure: (code: ImpdBareRefusalCode<'imps.destroy'> | null) => void;
  readonly setGrantRemovalFailure: (
    code: ImpdBareRefusalCode<'grants.delete'> | 'UNREACHABLE' | null,
  ) => void;
  readonly setVersionFailures: (count: number) => void;

  // How many version checks failed as an unreachable impd.
  readonly countFailedVersionChecks: () => number;

  readonly setNextSessionFailure: (refusal: ImpdExecRefusal, message?: string) => void;
  readonly setNextMalformedSessionFailure: (code: string, data: unknown) => void;
  readonly findState: (name: string) => ImpState | null;
  readonly collectImpNames: () => string[];
  readonly getBootID: (name: string) => string;
  readonly getGeneration: (name: string, session: string) => string;
  readonly getProcessArgv: (name: string, session: string) => readonly string[];
  readonly findUndeliveredExit: (
    name: string,
    session: string,
  ) => { readonly code: number | null } | null;
  readonly getEnd: (name: string, session: string) => number;

  // Runs once the current test finishes, or sooner when called, and only once.
  readonly stop: () => Promise<void>;
}

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
  const calls: string[] = [];
  const sessionRequests: ImpSessionRequest[] = [];
  const createSpecs: ImpCreateSpec[] = [];

  // Version checks still to fail as an unreachable impd before they answer.
  let versionFailures = 0;

  // Version checks that failed as an unreachable impd.
  let failedVersionChecks = 0;

  const stop = registerTestCleanup(async () => {
    const running = commands.kill();

    for (const imp of fleet.imps.values()) {
      for (const subprocess of imp.sessions.values()) {
        tryKill(subprocess.pty, 'SIGCONT');
        tryKill(subprocess.pty, 'SIGKILL');
      }
    }

    forwards.stop();
    fleet.imps.clear();

    await Promise.all(running.map((command) => command.exited));
  });

  const fleet = createStubImpFleet({ principal, now, calls, createSpecs });
  const secrets = createStubImpSecrets({ calls, fleet });
  const leases = createStubImpLeases({ calls, fleet });
  const commands = createStubImpCommands({ calls, imps: fleet.imps, report });
  const forwards = createStubImpForwards({ calls });

  const self: StubImpPort = {
    calls,

    sessionRequests,

    createSpecs,

    version: MIN_IMPD_VERSION,

    scratchDir: '/tmp',

    readOnlyFilesDir: null,

    continuity: 'offsets',

    resumeOverlap: 0,

    verifyVersion: () => {
      calls.push('system.info');

      if (versionFailures > 0) {
        versionFailures -= 1;
        failedVersionChecks += 1;

        return Promise.reject(new ImpPortError('UNREACHABLE', 'impd did not answer'));
      }

      const info: Pick<ImpdOutput<'system.info'>, 'version'> = { version: self.version };

      return new Promise((resolve) => {
        requireImpdVersion(info.version);
        resolve();
      });
    },

    // The real port answers from the status report its version check read,
    // so this records no call of its own.
    readGuestScratchDir: () => {
      const info: Pick<ImpdOutput<'system.info'>, 'version' | 'guest'> = {
        version: self.version,
        ...(self.scratchDir === null
          ? {}
          : { guest: { scratchDir: self.scratchDir, isClearedOnBoot: false } }),
      };

      return new Promise((resolve) => {
        resolve(requireGuestScratchDir(info));
      });
    },

    readIdentity: secrets.readIdentity,
    readSecrets: secrets.readSecrets,
    readGrants: secrets.readGrants,
    createGrant: secrets.createGrant,
    removeGrant: secrets.removeGrant,
    readImp: fleet.readImp,
    createImp: fleet.createImp,
    acquireLease: leases.acquireLease,
    renewLease: leases.renewLease,
    releaseLease: leases.releaseLease,
    suspendImp: fleet.suspendImp,
    destroyImp: fleet.destroyImp,

    openSession: (request, handlers, gate) => sessions.openSession(request, handlers, gate),

    // Replaces the file through a rename, at mode 0444, as impd's agent does.
    writeReadOnlyFile: async (name, path, content) => {
      calls.push(`files.write ${name} ${path}`);

      if (!fleet.imps.has(name)) {
        throw buildNotFound('files.write', name);
      }

      if (self.readOnlyFilesDir === null) {
        throw buildImpdRefusal(
          'files.write',
          { code: 'AGENT_OUTDATED' },
          "the imp's agent has no read-only files yet",
        );
      }

      const target = posix.join(self.readOnlyFilesDir, name, path);

      const staged = posix.join(
        posix.dirname(target),
        `.${posix.basename(target)}.${randomUUID()}`,
      );

      await mkdir(posix.dirname(target), { recursive: true });
      await writeFile(staged, content, { mode: 0o444, flag: 'wx' });
      await rename(staged, target);

      const written: ImpdOutput<'files.write'> = { path: target };

      return written.path;
    },

    runCommand: commands.runCommand,
    openReverseForward: forwards.openReverseForward,
    setIdentity: secrets.setIdentity,
    createSecret: secrets.createSecret,
    updateSecret: secrets.updateSecret,
    removeSecret: secrets.removeSecret,
    acquireOtherLease: leases.acquireOtherLease,
    suspendWithForce: fleet.suspendWithForce,
    killProcess: fleet.killProcess,
    bootImpCold: fleet.bootImpCold,
    stopConnection: fleet.stopConnection,
    stopRelays: forwards.stopRelays,
    stopForwards: forwards.stopForwards,
    startRelayRefusal: forwards.startRelayRefusal,
    stopRelayRefusal: forwards.stopRelayRefusal,

    startBrokerFailure: () => {
      sessions.startBrokerFailure();
    },

    stopBrokerFailure: () => {
      sessions.stopBrokerFailure();
    },

    startGuestByteDrop: forwards.startGuestByteDrop,
    stopGuestByteDrop: forwards.stopGuestByteDrop,
    countDroppedGuestBytes: forwards.countDroppedGuestBytes,

    startAnswerHold: () => {
      sessions.startAnswerHold();
    },

    countHeldAnswers: () => sessions.countHeldAnswers(),

    stopAnswerHold: () => {
      sessions.stopAnswerHold();
    },

    setAcquireFailure: leases.setAcquireFailure,

    setSessionDrops: (count, closeCode) => {
      sessions.setSessionDrops(count, closeCode);
    },

    setOpenFailures: (count) => {
      sessions.setOpenFailures(count);
    },

    setUpgradeFailures: (count) => {
      sessions.setUpgradeFailures(count);
    },

    setExecCheckFailures: (count) => {
      sessions.setExecCheckFailures(count);
    },

    countFailedExecChecks: () => sessions.countFailedExecChecks(),

    startUpgradeHold: () => {
      sessions.startUpgradeHold();
    },

    countHeldUpgrades: () => sessions.countHeldUpgrades(),

    stopUpgradeHold: () => {
      sessions.stopUpgradeHold();
    },

    subscribeToLeaseAcquires: leases.subscribeToLeaseAcquires,
    startLeaseHold: leases.startLeaseHold,
    countHeldLeases: leases.countHeldLeases,
    stopLeaseHold: leases.stopLeaseHold,
    startReleaseHold: leases.startReleaseHold,
    countHeldReleases: leases.countHeldReleases,
    stopReleaseHold: leases.stopReleaseHold,
    startDestroyHold: fleet.startDestroyHold,
    countHeldDestroys: fleet.countHeldDestroys,
    stopDestroyHold: fleet.stopDestroyHold,
    setHomeDir: commands.setHomeDir,
    setGuestPath: commands.setGuestPath,
    startCommandHold: commands.startCommandHold,
    countHeldCommands: commands.countHeldCommands,
    stopCommandHold: commands.stopCommandHold,
    setCommandFailure: commands.setCommandFailure,
    setDestroyFailure: fleet.setDestroyFailure,
    setGrantRemovalFailure: secrets.setGrantRemovalFailure,

    setVersionFailures: (count) => {
      versionFailures = count;
    },

    countFailedVersionChecks: () => failedVersionChecks,

    setNextSessionFailure: (refusal, message) => {
      sessions.setNextSessionFailure(refusal, message);
    },

    setNextMalformedSessionFailure: (code, data) => {
      sessions.setNextMalformedSessionFailure(code, data);
    },

    findState: fleet.findState,
    collectImpNames: fleet.collectImpNames,
    getBootID: fleet.getBootID,
    getGeneration: fleet.getGeneration,
    getProcessArgv: fleet.getProcessArgv,
    findUndeliveredExit: fleet.findUndeliveredExit,
    getEnd: fleet.getEnd,

    stop,
  };

  const sessions = createStubImpSessions({
    calls,
    sessionRequests,
    context: { fleet, commands, settings: self },
  });

  return self;
}
