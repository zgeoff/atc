import { DaemonError } from '@atc/protocol/wire';
import type { StubMemoryProvider } from './build-stub-memory-provider';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

// What the provider does in place of the in-memory defaults beyond the
// imp's own kind, remoteness, capabilities, guest layout, and workspace flags.
type StubRestoreImpProviderConfig = Pick<
  NonNullable<Parameters<typeof buildStubMemoryProvider>[0]>,
  'runCommand' | 'clock'
>;

export interface StubRestoreImpProvider extends StubMemoryProvider {
  readonly checkExistingHost: (host: string) => Promise<boolean>;

  // The imp a host key runs on: the host key under the `atc-` prefix.
  readonly getImpName: (hostKey: string) => string;

  // Every host key a host check asked about, in order.
  readonly checked: string[];

  // Every host key a prepare created an imp for, in order.
  readonly created: string[];

  // Adds an imp for the host key, as an operator or an earlier daemon
  // leaves one.
  readonly createHost: (hostKey: string) => void;

  // Refuses the next prepare as impd's refusal of the lease with the code
  // given; the prepares after it go through.
  readonly refuseNextPrepare: (code: string) => void;

  // Holds every prepare, and the next ones, until the hold stops.
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
    guest: { dir: '/tmp/atc', atc: null },
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

        // a refused prepare leaves no imp behind, as the imp provider destroys an imp
        // its failed prepare created

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
