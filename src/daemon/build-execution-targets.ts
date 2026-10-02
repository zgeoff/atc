import type { TargetConfig } from '../shared/collect-targets';
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
  readonly provider: ExecutionProvider | null;
}

/**
 * Builds one target per configured entry, in config order, each with a
 * provider of its kind when this daemon has one.
 */
export function buildExecutionTargets(configs: readonly TargetConfig[]): ExecutionTarget[] {
  return configs.map((config) => ({
    id: config.id,
    kind: config.provider,
    options: config.options,
    provider: config.provider === 'local-pty' ? new LocalPTYProvider() : null,
  }));
}
