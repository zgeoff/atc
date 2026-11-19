import type { ContainerInfo } from '../engine/types';

export type StartAction = 'attach' | 'unpause' | 'start' | 'replace' | 'create';

export function pickHarnessStart(container: ContainerInfo | null): StartAction {
  if (container === null) {
    return 'create';
  }

  if (container.status === 'running' || container.status === 'restarting') {
    return 'attach';
  }

  if (container.status === 'paused') {
    return 'unpause';
  }

  return container.status === 'created' ? 'start' : 'replace';
}
