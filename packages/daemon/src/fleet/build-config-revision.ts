import { createHash } from 'node:crypto';
import type { TargetConfigError } from '@atc/config';
import type { AgentEntry } from '../sessions/build-agent-list';
import type { ExecutionTarget } from './build-execution-targets';

interface AgentRevisionInput {
  readonly entries: readonly AgentEntry[];
  readonly defaultAgent: string;
}

export function buildConfigRevision(
  targets: readonly ExecutionTarget[],
  defaultTarget: string | null,
  errors: readonly TargetConfigError[],
  agents: AgentRevisionInput,
): string {
  const canonical = JSON.stringify({
    targets: targets.map((target) => [target.id, target.identity]),
    defaultTarget,
    agents: agents.entries,
    defaultAgent: agents.defaultAgent,
    errors: errors.map((error) =>
      error.scope === 'config'
        ? [error.scope, error.path, error.problem, error.detail]
        : [error.scope, error.target ?? null, error.problem],
    ),
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
