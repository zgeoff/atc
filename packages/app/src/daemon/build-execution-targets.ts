import type { TargetConfig, TargetConfigError } from '../shared/collect-targets';
import { buildImpProvider } from './build-imp-provider';
import { buildTargetIdentity } from './build-target-identity';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

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
export interface ExecutionTargetsBuild {
  readonly targets: ExecutionTarget[];
  readonly errors: TargetConfigError[];
}

/**
 * Builds one target per configured entry, in config order, each with a
 * provider of its kind when this daemon has one. An entry whose provider
 * cannot start from `env` keeps no provider and adds a target error.
 */
export function buildExecutionTargets(
  configs: readonly TargetConfig[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutionTargetsBuild {
  const errors: TargetConfigError[] = [];

  const targets = configs.map((config) => {
    const built = buildProvider(config, env);

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
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ provider: ExecutionProvider | null; problem: string | null }> {
  if (config.provider === 'local-pty') {
    return { provider: new LocalPTYProvider(), problem: null };
  }

  return config.provider === 'imp'
    ? buildImpProvider(config.id, config.options, env)
    : { provider: null, problem: null };
}
