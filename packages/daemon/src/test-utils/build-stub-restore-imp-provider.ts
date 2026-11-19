import { DaemonError } from '@atc/protocol/wire';
import type { StubMemoryProvider } from './build-stub-memory-provider';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

type StubRestoreImpProviderConfig = Pick<
  NonNullable<Parameters<typeof buildStubMemoryProvider>[0]>,
  'runCommand' | 'clock'
>;

export interface StubRestoreImpProvider extends StubMemoryProvider {
  readonly checkExistingHost: (host: string) => Promise<boolean>;

  readonly getImpName: (hostKey: string) => string;

  readonly checked: string[];

  readonly created: string[];

  readonly createHost: (hostKey: string) => void;

  readonly refuseNextPrepare: (code: string) => void;

  readonly startPrepareHold: () => void;
  readonly countHeldPrepares: () => number;
  readonly stopPrepareHold: () => void;
}

export function buildStubRestoreImpProvider(
  config: StubRestoreImpProviderConfig = {},
): StubRestoreImpProvider {
  const imps = new Set<string>();

  const checked: string[] = [];
  const created: string[] = [];
  let refusal: string | null = null;
  let hold: PromiseWithResolvers<void> | null = null;
  let heldPrepares = 0;

  const provider = buildStubMemoryProvider({
    ...config,
    kind: 'imp',
    remote: true,
    capabilities: { headless: false, suspend: true, destroy: true },
    guest: { directory: '/tmp/atc', atc: null },
    cloneOnTarget: true,
    hostGitIdentity: true,
    guestWorkspaceTrust: true,
    prepareHost: async (request) => {
      if (hold !== null) {
        heldPrepares += 1;

        await hold.promise;

        heldPrepares -= 1;
      }

      const code = refusal;

      if (code !== null) {
        refusal = null;

        // The real provider destroys an imp that its failed prepare created, so a refused prepare
        // leaves no imp behind.

        throw new DaemonError(
          'host_unavailable',
          `imp ${getImpName(request.host)} cannot be used: impd refused the lease (${code})`,
          { provider: 'imp', problem: code.toLowerCase() },
        );
      }

      if (!imps.has(request.host)) {
        imps.add(request.host);
        created.push(request.host);
      }
    },
  });

  return {
    ...provider,
    checkExistingHost: (host) => {
      checked.push(host);

      return Promise.resolve(imps.has(host));
    },
    getImpName,
    checked,
    created,
    createHost: (hostKey) => {
      imps.add(hostKey);
    },
    refuseNextPrepare: (code) => {
      refusal = code;
    },
    startPrepareHold: () => {
      hold ??= Promise.withResolvers<void>();
    },
    countHeldPrepares: () => heldPrepares,
    stopPrepareHold: () => {
      hold?.resolve();
      hold = null;
    },
  };
}

function getImpName(hostKey: string): string {
  return `atc-${hostKey}`;
}
