import type { SessionLifecycle } from '@atc/protocol/session-lifecycle';

// The session facts the layers derive from.
interface LifecycleFacts {
  readonly desired: SessionLifecycle['desired'];
  readonly vm: SessionLifecycle['vm'];
  readonly attachment: SessionLifecycle['attachment'];

  // Whether the harness is kept inside a sleeping host.
  readonly suspended: boolean;
  readonly hasHarness: boolean;
  readonly kind: 'pty' | 'headless';
  readonly state: 'running' | 'needs_you' | 'done' | 'exited';
}

/**
 * Builds the four layers from a session's facts. The harness runs while the
 * session holds a terminal or a live headless run. A harness without one is
 * suspended while it is kept inside a sleeping host, and exited otherwise.
 */
export function buildSessionLifecycle(facts: Readonly<LifecycleFacts>): SessionLifecycle {
  const running = facts.hasHarness || (facts.kind === 'headless' && facts.state !== 'exited');
  let harness: SessionLifecycle['harness'] = 'exited';

  if (running) {
    harness = 'running';
  } else if (facts.suspended && facts.vm === 'asleep') {
    harness = 'suspended';
  }

  return { desired: facts.desired, vm: facts.vm, harness, attachment: facts.attachment };
}
