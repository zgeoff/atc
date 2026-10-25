import type { SessionDescriptor, SessionID } from '@atcx/contract';
import type { SessionManager } from './create-session-manager';

// The manager as the lookup reads it.
interface DescriptorSource {
  readonly collectDescriptors: SessionManager['collectDescriptors'];
}

export function getDescriptor(manager: DescriptorSource, id: SessionID): SessionDescriptor {
  const descriptor = manager.collectDescriptors().find((x) => x.id === id);

  if (descriptor === undefined) {
    throw new Error(`descriptor for unknown session ${id}`);
  }

  return descriptor;
}
