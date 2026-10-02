import type { SpawnOverrides } from '../agents/agent-adapter';
import type { AgentEntry, SpawnOptionEntry } from './build-agent-list';

interface RequestedOverrides {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

interface SpawnRefusal {
  readonly ok: false;
  readonly code: 'bad_args' | 'unsupported';
  readonly message: string;
}

type ParsedOverrides = { readonly ok: true; readonly overrides: SpawnOverrides } | SpawnRefusal;

/**
 * Checks a spawn's model and effort against the options the agent list
 * shows for that agent, so a spawn accepts exactly what `agents.list`
 * advertises. An option the agent cannot take on this host is unsupported,
 * never ignored. A value outside an option's closed set, or one that could
 * pass for a flag, is bad_args.
 */
export function parseSpawnOverrides(
  agent: AgentEntry,
  requested: RequestedOverrides,
): ParsedOverrides {
  const model = requested.model;
  const effort = requested.effort;

  const refusal =
    (model === undefined
      ? null
      : findOptionRefusal(agent.id, 'model', agent.spawnOptions.model, model)) ??
    (effort === undefined
      ? null
      : findOptionRefusal(agent.id, 'effort', agent.spawnOptions.effort, effort));

  if (refusal !== null) {
    return refusal;
  }

  return {
    ok: true,
    overrides: {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    },
  };
}

const MAX_VALUE_LENGTH = 200;

// oxlint-disable-next-line no-control-regex -- control characters are what a value is refused for
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;

function findOptionRefusal(
  agentID: string,
  name: 'model' | 'effort',
  option: SpawnOptionEntry,
  value: string,
): SpawnRefusal | null {
  if (!option.available) {
    const reason = option.supported ? 'is not installed on this host' : `takes no ${name}`;

    return { ok: false, code: 'unsupported', message: `agent '${agentID}' ${reason}` };
  }

  if (value === '' || value.length > MAX_VALUE_LENGTH) {
    return {
      ok: false,
      code: 'bad_args',
      message: `${name} must be 1 to ${MAX_VALUE_LENGTH} characters`,
    };
  }

  if (value.startsWith('-') || CONTROL_CHARACTER.test(value)) {
    return {
      ok: false,
      code: 'bad_args',
      message: `${name} must not start with '-' or hold control characters`,
    };
  }

  if (option.values !== null && !option.values.includes(value)) {
    return {
      ok: false,
      code: 'bad_args',
      message: `agent '${agentID}' takes ${name} ${option.values.join(', ')}; got '${value}'`,
    };
  }

  return null;
}
