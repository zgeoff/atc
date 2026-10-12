import type { TargetConfig, TargetConfigError } from '@atc/config/collect-targets';
import { buildImpProvider } from '@atc/execution-imp/build-imp-provider';
import { LocalPTYProvider } from '@atc/execution-local/local-pty-provider';
import type { ExecutionProvider } from '@atc/plugin-api/execution-provider';
import { buildTargetIdentity } from '@atc/store/build-target-identity';

/**
 * A configured place sessions run, with the provider that serves it. The
 * provider is null when this daemon has no provider of the configured kind:
 * the target still lists, and a spawn to it fails rather than running
 * anywhere else.
 */
export interface ExecutionTarget {
  readonly id: string;
  readonly kind: string;
  readonly options: Readonly<Record<string, unknown>>;

  // The identity a session spawned here binds to.
  readonly identity: string;
  readonly provider: ExecutionProvider | null;
}

/**
 * The targets the daemon serves, and the problems with their entries that
 * only the daemon's environment shows.
 */
interface ExecutionTargetsBuild {
  readonly targets: ExecutionTarget[];
  readonly errors: TargetConfigError[];
}

/**
 * Builds one target per configured entry, in config order, each with a
 * provider of its kind when this daemon has one. `version` holds the atc
 * version the daemon runs, which an imp's atc must match. An entry whose
 * provider cannot start from `env` keeps no provider and adds a target
 * error.
 */
export function buildExecutionTargets(
  configs: readonly TargetConfig[],
  version: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutionTargetsBuild {
  const errors: TargetConfigError[] = [];

  const targets = configs.map((config) => {
    const built = buildProvider(config, version, env);

    if (built.problem !== null) {
      errors.push({ scope: 'target', target: config.id, problem: built.problem });
    }

    return {
      id: config.id,
      kind: config.provider,
      options: config.options,
      identity: buildTargetIdentity(config.provider, config.options),
      provider: built.provider,
    };
  });

  return { targets, errors };
}

function buildProvider(
  config: TargetConfig,
  version: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ provider: ExecutionProvider | null; problem: string | null }> {
  if (config.provider === 'local-pty') {
    return { provider: new LocalPTYProvider(), problem: null };
  }

  return config.provider === 'imp'
    ? buildImpProvider(config.id, config.options, version, env)
    : { provider: null, problem: null };
}
