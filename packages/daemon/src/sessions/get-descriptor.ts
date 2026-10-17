import type { SessionID } from '@atc/core';
import type { SessionDescriptor } from '@atc/protocol';
import type { SessionManager } from './sessions';

// The manager as the lookup reads it.
interface DescriptorSource {
  readonly collectDescriptors: SessionManager['collectDescriptors'];
}

export function getDescriptor(mgr: DescriptorSource, id: SessionID): SessionDescriptor {
  const d = mgr.collectDescriptors().find((x) => x.id === id);

  if (d === undefined) {
    throw new Error(`descriptor for unknown session ${id}`);
  }

  return d;
}
