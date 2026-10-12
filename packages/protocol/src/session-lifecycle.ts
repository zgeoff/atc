import { z } from 'zod';

/**
 * A session's lifecycle as four layers, each owned by one actor:
 *
 * - `desired`: what the operator asked for. `run` keeps the harness
 *   running, `sleep` keeps its host asleep with the harness inside it, and
 *   `stop` leaves the harness ended.
 * - `vm`: the host the harness runs on. `none` is the daemon's own machine,
 *   which has no lifecycle of its own; `awake`, `asleep`, and `unknown` are
 *   the last state the daemon saw of a remote host.
 * - `harness`: the agent process. `suspended` is a process kept inside a
 *   sleeping host, which a revive brings back as it was.
 * - `attachment`: the daemon's own connection to the harness's output.
 *   `local` is a harness in the daemon's process tree; `attached`,
 *   `reattaching`, and `detached` follow the connection to a remote one.
 */
export const SESSION_LIFECYCLE_SCHEMA = z.object({
  desired: z.enum(['run', 'sleep', 'stop']),
  vm: z.enum(['none', 'awake', 'asleep', 'unknown']),
  harness: z.enum(['running', 'suspended', 'exited']),
  attachment: z.enum(['local', 'attached', 'reattaching', 'detached']),
});

export type SessionLifecycle = Readonly<z.output<typeof SESSION_LIFECYCLE_SCHEMA>>;
