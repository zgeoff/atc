import { DaemonError } from '../protocol/daemon-error';
import type { TargetConfigError } from '../shared/collect-targets';
import type { ExecutionTarget } from './build-execution-targets';
import type { ExecutionCapability } from './execution-provider';

// The target a session runs on and the identity it was bound to there; a
// null identity is a session not yet bound, which binds to the target as
// it stands now. A null target is a spawn that names none when the config
// gives no default.
interface TargetBinding {
  readonly target: string | null;
  readonly targetIdentity: string | null;
}

/**
 * The refusal for running work of the given capability on a session's
 * target, or null when the target serves it. Every path that starts a
 * harness, writes to one, or runs a headless turn asks this first, so no
 * path runs a session anywhere but the target it is bound to:
 *
 * - `target_config_invalid` when the config file exists but cannot be
 *   read or parsed, which refuses every target, `local` included; when the
 *   config's `targets` map, or the target's own entry, is malformed; and
 *   when there is no target because the config gives no default.
 * - `unknown_target` when no target holds the id.
 * - `target_changed` when the target's identity is not the one the session
 *   was bound to: the name now holds another provider or other options.
 * - `target_unavailable` when this daemon has no provider of its kind.
 * - `unsupported_operation` when the provider lacks the capability.
 */
export function findExecutionRefusal(
  targets: ReadonlyMap<string, ExecutionTarget>,
  errors: readonly TargetConfigError[],
  binding: TargetBinding,
  capability: ExecutionCapability,
): DaemonError | null {
  const fileError = errors.find((error) => error.scope === 'config');

  if (fileError !== undefined) {
    return new DaemonError(
      'target_config_invalid',
      `config file ${fileError.path} cannot be used (${fileError.problem}: ${fileError.detail}), so no session runs on any target, local included. Fix the file and restart the daemon`,
      { problem: fileError.problem, path: fileError.path, detail: fileError.detail },
    );
  }

  const id = binding.target;

  if (id === null) {
    const problem =
      errors.find((error) => error.scope !== 'target')?.problem ??
      'the targets map holds no local target and no defaultTarget is set';

    return new DaemonError(
      'target_config_invalid',
      `no default execution target: ${problem}. Name a target on the spawn, or fix targets in config.json and restart the daemon`,
      { problem },
    );
  }

  const configError = errors.find(
    (error) => error.scope === 'targets' || (error.scope === 'target' && error.target === id),
  );

  if (configError !== undefined) {
    return new DaemonError(
      'target_config_invalid',
      `execution target '${id}' cannot be used: ${configError.problem}. Fix targets in config.json and restart the daemon`,
      { target: id, problem: configError.problem },
    );
  }

  const target = targets.get(id);

  if (target === undefined) {
    return new DaemonError('unknown_target', `no execution target '${id}'`, { target: id });
  }

  if (binding.targetIdentity !== null && binding.targetIdentity !== target.identity) {
    return new DaemonError(
      'target_changed',
      `execution target '${id}' changed since this session started on it (was ${binding.targetIdentity}, now ${target.identity}). Restore the target's earlier config to use the session, or kill it`,
      { target: id, boundIdentity: binding.targetIdentity, currentIdentity: target.identity },
    );
  }

  if (target.provider === null) {
    return new DaemonError(
      'target_unavailable',
      `execution target '${id}' needs a '${target.kind}' provider, which this daemon does not have`,
      { target: id, provider: target.kind },
    );
  }

  if (!target.provider.capabilities[capability]) {
    return new DaemonError(
      'unsupported_operation',
      `the ${target.provider.kind} execution provider does not support ${capability}`,
      { provider: target.provider.kind, capability },
    );
  }

  return null;
}
