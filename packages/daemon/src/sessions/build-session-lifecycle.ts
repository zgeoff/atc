import type { SessionLifecycle } from '@atcx/contract';

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
