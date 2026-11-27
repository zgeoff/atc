import { collectSessionContainers } from '@atc/execution-docker/test-utils/collect-session-containers';
import { readDockerLines } from '@atc/execution-docker/test-utils/read-docker-lines';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import type { Endpoints } from '@wringer/core';
import { waitFor } from '@zgeoff/testing';
import { dockerTokenValue } from './constants.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';

export interface DockerSessionState {
  readonly containers: string[];
  readonly volumes: string[];
  readonly tokenInEnv: boolean;
  readonly tokenSeenByHarness: boolean;
}

export async function readDockerSession(endpoints: Endpoints): Promise<DockerSessionState> {
  const run = parseDockerRunEndpoints(endpoints);
  const filter = ['--filter', `name=${run.prefix}`];

  const names = await readDockerLines('ps', '-a', '--format', '{{.Names}}', ...filter);
  const volumes = await readDockerLines('volume', 'ls', '-q', ...filter);

  const session = collectSessionContainers(names, run.prefix);
  let tokenInEnv = false;

  for (const name of session.containers) {
    const env = await runDocker('inspect', '--format', '{{json .Config.Env}}', name);

    tokenInEnv ||= env.includes(dockerTokenValue);
  }

  const seen = session.harness === undefined ? '' : await readTokenSeen(session.harness);

  return {
    containers: session.containers,
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
