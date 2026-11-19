import type { ContainerInfo, Labels } from '../engine/types';
import { buildHostRefusal } from './build-host-refusal';

const OWNER_LABELS = ['atc.target', 'atc.host', 'atc.daemon'] as const;

export function requireOwnContainer(existing: ContainerInfo | null, expected: Labels): void {
  if (existing === null) {
    return;
  }

  if (OWNER_LABELS.every((label) => existing.labels[label] === expected[label])) {
    return;
  }

  throw buildHostRefusal(
    'host_leased',
    `container ${existing.name} exists and is not of this daemon's host, and atc never takes it over`,
    { container: existing.name },
  );
}
