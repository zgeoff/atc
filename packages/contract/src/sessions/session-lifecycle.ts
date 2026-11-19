import { z } from 'zod';

export const SESSION_LIFECYCLE_SCHEMA = z.object({
  desired: z.enum(['run', 'sleep', 'stop']),
  vm: z.enum(['none', 'awake', 'asleep', 'unknown']),
  harness: z.enum(['running', 'suspended', 'exited']),
  attachment: z.enum(['local', 'attached', 'reattaching', 'detached']),
});

export type SessionLifecycle = Readonly<z.output<typeof SESSION_LIFECYCLE_SCHEMA>>;
