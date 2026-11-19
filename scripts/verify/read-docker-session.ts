import { waitFor } from '@atc/core/test-utils/wait-for';
import { readDockerLines } from '@atc/execution-docker/test-utils/read-docker-lines';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import type { Endpoints } from '@wringer/core';
import { dockerTokenValue } from './constants.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';

export interface DockerSessionState {
  readonly containers: string[];
  readonly volumes: string[];
  readonly tokenInEnv: boolean;
  readonly tokenSeenByHarness: boolean;
}

// What the run's docker objects look like: the containers and volumes under the run's prefix,
// whether any container's environment holds the token, and whether the harness itself saw it.
export async function readDockerSession(endpoints: Endpoints): Promise<DockerSessionState> {
  const run = parseDockerRunEndpoints(endpoints);
  const filter = ['--filter', `name=${run.prefix}`];

  const names = await readDockerLines('ps', '-a', '--format', '{{.Names}}', ...filter);
  const volumes = await readDockerLines('volume', 'ls', '-q', ...filter);

  const harness = names.find((name) => !name.endsWith('-relay'));
  let tokenInEnv = false;

  for (const name of names) {
    const env = await runDocker('inspect', '--format', '{{json .Config.Env}}', name);

    tokenInEnv ||= env.includes(dockerTokenValue);
  }

  const seen = harness === undefined ? '' : await readTokenSeen(harness);

  return {
    containers: names.toSorted(),
    volumes: volumes.toSorted(),
    tokenInEnv,
    tokenSeenByHarness: seen === 'token-matches',
  };
}

// The stand-in writes the file once it starts, a moment after the container does.
function readTokenSeen(harness: string): Promise<string> {
  return waitFor(() => runDocker('exec', harness, 'cat', '/home/agent/token-seen'), {
    timeoutMs: 15_000,
    intervalMs: 200,
  });
}
