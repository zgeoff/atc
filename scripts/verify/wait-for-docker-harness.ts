import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import { waitFor } from '@zgeoff/testing';

// The daemon lists a docker session as alive once it holds the harness handle, before the
// provider has started the relay sidecar or the harness container, so `alive` says nothing about
// either container.
export function waitForDockerHarness(prefix: string, session: string): Promise<void> {
  const harness = `${prefix}${session}`;

  return waitFor(
    async () => {
      const status = await runDocker('inspect', '--format', '{{.State.Status}}', harness);

      if (status !== 'running') {
        throw new Error(`harness container ${harness} is ${status}`);
      }
    },
    { timeoutMs: 15_000, intervalMs: 200, label: `harness container ${harness} running` },
  );
}
