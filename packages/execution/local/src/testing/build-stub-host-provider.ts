import type { ExecutionProvider } from '@atc/plugin-api';
import { LocalPTYProvider } from '../local-pty-provider';

export function buildStubHostProvider(): ExecutionProvider {
  const local = new LocalPTYProvider();

  return {
    kind: 'imp-like',
    remote: false,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    prepareHost: () => Promise.resolve(),
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: () => Promise.resolve(),
    dispose: local.dispose,
  };
}
