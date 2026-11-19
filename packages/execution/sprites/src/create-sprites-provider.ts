import { readFile } from 'node:fs/promises';
import { createStepTimer, makeKeyedLock } from '@atc/core';
import type {
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessFate,
  HostCredentials,
  HostFact,
  HostRequest,
} from '@atc/plugin-api';
import { EffectRemainsError, openStreamRelay } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { SESSION_ENV_NAMES } from '@atcx/contract/light';
import type { SpritesTarget } from './config/parse-sprites-target';
import { UNPACK_ARCHIVE_SCRIPT } from './guest-scripts/unpack-archive-script';
import type { SpritesPort } from './port/types';
import { buildHomeRelativeCommand } from './provider/build-home-relative-command';
import { buildHostRefusal } from './provider/build-host-refusal';
import { buildRecordPath } from './provider/build-record-path';
import { buildSessionPaths } from './provider/build-session-paths';
import { createConnectorRouter } from './provider/create-connector-router';
import { createGuestRecords } from './provider/create-guest-records';
import type { HostRecord } from './provider/create-guest-records';
import { createSpritesHarness } from './provider/create-sprites-harness';
import { createTrackedPort } from './provider/create-tracked-port';
import { makeMuxLink } from './provider/make-mux-link';
import { runExec } from './provider/run-exec';
import { toSpritesRefusal } from './provider/to-sprites-refusal';

export interface SpritesProvider extends ExecutionProvider {
  readonly kind: 'sprites';
  readonly credentials: Extract<HostCredentials, { readonly kind: 'routed' }>;
  readonly readGuest: (host: string) => Promise<GuestLayout>;
  readonly findHostFact: (host: string) => HostFact;
  readonly checkExistingHost: (host: string) => Promise<boolean>;
  readonly writeReadOnlyFile: (host: string, path: string, content: string) => Promise<string>;
  readonly readHarnessFates: NonNullable<ExecutionProvider['readHarnessFates']>;
  readonly dispose: () => void;
}

interface SpritesProviderOptions {
  // the id of the target the provider serves, which a host record names
  readonly targetID: string;

  // the daemon's compiled binary, which the provider uploads into each sprite
  readonly atcBinary: string;

  // the daemon's build stamp, which tells a sprite's copy of the binary from a stale one
  readonly getBuild: () => string;

  // the wait before each reconnect to a harness or a relay whose connection ended
  readonly reconnectDelaysMs?: readonly number[];
  readonly log?: (line: string) => void;
}

interface Detachable {
  readonly detach: () => void;
}

interface HostCommand {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
}

const RECONNECT_DELAYS_MS: readonly number[] = [250, 1000, 2000, 4000];

const capabilities: ExecutionCapabilities = {
  spawn: true,
  attach: true,
  input: true,
  resize: true,
  kill: true,
  transfer: true,
  run: true,
  headless: false,
  suspend: true,
  destroy: true,
  relay: true,
};

export function createSpritesProvider(
  port: SpritesPort,
  target: SpritesTarget,
  options: SpritesProviderOptions,
): SpritesProvider {
  const log = options.log ?? (() => {});
  const reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const tracked = createTrackedPort(port);
  const api = tracked.port;
  const records = createGuestRecords(api, target.guestDir);
  const withHostTurn = makeKeyedLock();

  const encoder = new TextEncoder();

  const guestATC = `${target.guestDir}/bin/atc`;

  const spriteIDs = new Map<string, string>();
  const harnesses = new Map<string, Set<Detachable>>();

  const buildSpriteName = (host: string): string => `${target.spritePrefix}${host}`;

  const trackHarness = (host: string, harness: Detachable): void => {
    const held = harnesses.get(host) ?? new Set();

    held.add(harness);
    harnesses.set(host, held);
  };

  const detachHarnesses = (host: string): void => {
    for (const harness of harnesses.get(host) ?? []) {
      harness.detach();
    }

    harnesses.delete(host);
  };

  const isOwnRecord = (record: HostRecord | null, host: string, daemon?: string): boolean =>
    record !== null &&
    record.target === options.targetID &&
    record.host === host &&
    (daemon === undefined || record.daemon === daemon);

  const ensureBinary = async (sprite: string): Promise<void> => {
    const stamp = options.getBuild();
    const stampPath = `${guestATC}.build`;

    const known = await api.readFile(sprite, stampPath);

    if (known !== null && new TextDecoder().decode(known) === stamp) {
      return;
    }

    const binary = await readFile(options.atcBinary);

    await api.writeFile(sprite, guestATC, new Uint8Array(binary), 0o755);
    await api.writeFile(sprite, stampPath, encoder.encode(stamp), 0o644);
  };

  const prepareHostInTurn = async (request: HostRequest): Promise<void> => {
    const timer = request.timer ?? createStepTimer();
    const sprite = buildSpriteName(request.host);
    let created = false;

    try {
      const existing = await timer.withStep('sprite-read', () => api.readSprite(sprite));

      if (existing === null) {
        const made = await timer.withStep('sprite-create', () => api.createSprite(sprite));

        created = true;

        spriteIDs.set(request.host, made.id);

        await records.writeHostRecord(sprite, {
          target: options.targetID,
          host: request.host,
          daemon: request.daemonID,
        });
      } else {
        const record = await records.readHostRecord(sprite);

        if (!isOwnRecord(record, request.host, request.daemonID)) {
          throw buildHostRefusal(
            'host_exists',
            `sprite ${sprite} exists and is not a host of target ${options.targetID}`,
            { sprite },
          );
        }

        spriteIDs.set(request.host, existing.id);
      }

      await timer.withStep('sprite-atc', () => ensureBinary(sprite));
    } catch (error) {
      const refusal = toSpritesRefusal(error);

      if (created) {
        spriteIDs.delete(request.host);

        if (!(await tryRemoveSprite(sprite))) {
          throw new EffectRemainsError(
            `host ${request.host} failed to ready and deleting the sprite it created failed too`,
            { cause: refusal },
          );
        }
      }

      throw refusal;
    }
  };

  const tryRemoveSprite = async (sprite: string): Promise<boolean> => {
    try {
      await api.removeSprite(sprite);

      return true;
    } catch {
      return false;
    }
  };

  const runOnHost = (host: string | undefined, command: HostCommand) => {
    if (host === undefined) {
      throw new Error('the sprites provider runs a command only on a session host');
    }

    const request = {
      argv: command.argv,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    };

    return guard(() => runExec(api, buildSpriteName(host), request, command.stdin));
  };

  return {
    kind: 'sprites',
    remote: true,
    capabilities,
    credentials: {
      kind: 'routed',
      router: createConnectorRouter(api, target.spritePrefix, target.apiURL),
    },
    hostGitIdentity: true,

    readGuest: () => Promise.resolve({ directory: target.guestDir, atc: guestATC, signIn: null }),

    prepareHost: (request) => withHostTurn(request.host, () => prepareHostInTurn(request)),

    checkExistingHost: async (host) => {
      try {
        const existing = await api.readSprite(buildSpriteName(host));

        if (existing === null) {
          spriteIDs.delete(host);

          return false;
        }

        spriteIDs.set(host, existing.id);

        return true;
      } catch {
        return false;
      }
    },

    findHostFact: (host) => {
      const id = spriteIDs.get(host);

      return { name: buildSpriteName(host), ...(id === undefined ? {} : { id }) };
    },

    readHarnessFates: (host, sessions) =>
      guard(async () => {
        const sprite = buildSpriteName(host);

        const fates = new Map<string, HarnessFate>();

        const view = await api.readSprite(sprite);

        // a read of a sleeping sprite would wake it, so its sessions stay unknown
        if (view?.status !== 'running') {
          return fates;
        }

        const boot = await records.readBootID(sprite);
        const execs = await api.listExecs(sprite);

        for (const session of sessions) {
          const record = await records.readSessionRecord(sprite, session);

          const recorded = record?.harness ?? null;

          if (recorded === null) {
            continue;
          }

          const isHeld = recorded.boot === boot && execs.some((exec) => exec.id === recorded.exec);
          const fate: HarnessFate = isHeld ? 'kept' : 'lost';

          fates.set(session, fate);
        }

        return fates;
      }),

    spawnHarness: (spec) => {
      const sprite = buildSpriteName(spec.host);
      const paths = buildSessionPaths(target.guestDir, spec.session);
      const command = buildHomeRelativeCommand([spec.bin, ...spec.args], spec.cwd);
      const { [SESSION_ENV_NAMES.socket]: _socket, ...planned } = spec.env;

      const link = makeMuxLink({
        api,
        records,
        sprite,
        session: spec.session,
        argv: [guestATC, 'relay-mux', paths.socket],
        prepare: async () => {
          await runExec(api, sprite, { argv: ['mkdir', '-p', paths.relayDir] });
        },
        log,
      });

      const relay = openStreamRelay(link, spec.onRelay ?? (() => {}), { reconnectDelaysMs, log });

      const harness = createSpritesHarness({
        api,
        records,
        sprite,
        session: spec.session,
        start: {
          argv: command.argv,
          cwd: command.cwd,
          env: {
            TERM: 'xterm-256color',
            LANG: 'C.UTF-8',
            ...planned,
            ...buildSessionEnv({ socket: paths.socket, bridge: true, outbox: paths.outbox }),
          },
          cols: spec.cols,
          rows: spec.rows,
        },
        relay,
        reconnectDelaysMs,
        log,
        onDone: () => {
          harnesses.get(spec.host)?.delete(harness);
        },
      });

      trackHarness(spec.host, harness);

      return harness;
    },

    transferArchive: async (archive, directory, host) => {
      const result = await runOnHost(host, {
        argv: ['sh', '-c', UNPACK_ARCHIVE_SCRIPT, 'sh', directory],
        stdin: archive,
      });

      if (result.exitCode !== 0) {
        throw new Error(`tar exited ${result.exitCode} unpacking into ${directory}`);
      }
    },

    runCommand: async (spec) => {
      const command = buildHomeRelativeCommand(spec.argv, spec.cwd);

      const result = await runOnHost(spec.host, { argv: command.argv, cwd: command.cwd });

      const decoder = new TextDecoder();

      return {
        exitCode: result.exitCode,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },

    // The agent's user owns the file, so the agent can change its mode and overwrite it.
    writeReadOnlyFile: async (host, path, content) => {
      const file = buildRecordPath(target.guestDir, path);

      if (file === null) {
        throw new Error(`the records folder takes no path like ${JSON.stringify(path)}`);
      }

      const bytes = encoder.encode(content);

      await guard(() => api.writeFile(buildSpriteName(host), file, bytes, 0o444));

      return file;
    },

    suspendHost: (host, isIdle) =>
      withHostTurn(host, () => {
        if (isIdle !== undefined && !isIdle()) {
          return Promise.reject(
            buildHostRefusal(
              'busy',
              `host ${host} stays awake: a session runs there or is starting there`,
            ),
          );
        }

        // the sprite sleeps once no client is attached, the relay's included
        detachHarnesses(host);

        tracked.detachAll(buildSpriteName(host));

        return Promise.resolve();
      }),

    destroyHost: (host) =>
      withHostTurn(host, async () => {
        const sprite = buildSpriteName(host);

        detachHarnesses(host);

        tracked.detachAll(sprite);

        await guard(async () => {
          const existing = await api.readSprite(sprite);

          if (existing === null) {
            return;
          }

          const record = await records.readHostRecord(sprite);

          if (!isOwnRecord(record, host)) {
            throw buildHostRefusal(
              'host_exists',
              `sprite ${sprite} is not a host of target ${options.targetID}, and atc never deletes it`,
              { sprite },
            );
          }

          await api.removeSprite(sprite);
        });

        spriteIDs.delete(host);
      }),

    dispose: () => {
      for (const host of harnesses.keys()) {
        detachHarnesses(host);
      }
    },
  };
}

// runs a call on the API, with any failure as the refusal a caller sees
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSpritesRefusal(error);
  }
}
