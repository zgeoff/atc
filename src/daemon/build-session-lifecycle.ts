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
export interface SessionLifecycle {
  readonly desired: 'run' | 'sleep' | 'stop';
  readonly vm: 'none' | 'awake' | 'asleep' | 'unknown';
  readonly harness: 'running' | 'suspended' | 'exited';
  readonly attachment: 'local' | 'attached' | 'reattaching' | 'detached';
}

// The session facts the layers derive from.
interface LifecycleFacts {
  readonly desired: SessionLifecycle['desired'];
  readonly vm: SessionLifecycle['vm'];
  readonly attachment: SessionLifecycle['attachment'];
  readonly hasHarness: boolean;
  readonly kind: 'pty' | 'headless';
  readonly state: 'running' | 'needs_you' | 'done' | 'exited';
}

/**
 * Builds the four layers from a session's facts. The harness runs while the
 * session holds a terminal or a live headless run. A harness without one is
 * suspended while the operator keeps its host asleep and the host is
 * asleep, and exited otherwise.
 */
export function buildSessionLifecycle(facts: Readonly<LifecycleFacts>): SessionLifecycle {
  const running = facts.hasHarness || (facts.kind === 'headless' && facts.state !== 'exited');
  let harness: SessionLifecycle['harness'] = 'exited';

  if (running) {
    harness = 'running';
  } else if (facts.desired === 'sleep' && facts.vm === 'asleep') {
    harness = 'suspended';
  }

  return { desired: facts.desired, vm: facts.vm, harness, attachment: facts.attachment };
}
