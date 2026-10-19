import type { SpawnOverrides } from '@atc/plugin-api';
import { findPluginDirProblem } from '@atc/plugin-api';
import { CONTROL_CHARACTER } from '@atc/protocol';
import type { AgentEntry, SpawnOptionEntry } from './build-agent-list';

interface RequestedOverrides {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly pluginDirs?: readonly string[] | undefined;
}

interface SpawnRefusal {
  readonly ok: false;
  readonly code: 'bad_args' | 'unsupported';
  readonly message: string;
}

type ParsedOverrides = { readonly ok: true; readonly overrides: SpawnOverrides } | SpawnRefusal;

// an option the agent cannot take here is unsupported, never ignored; a value outside a closed
// set, or one that could pass for a flag, is bad_args
export function parseSpawnOverrides(
  agent: AgentEntry,
  requested: RequestedOverrides,
): ParsedOverrides {
  const model = requested.model;
  const effort = requested.effort;
  const pluginDirs = requested.pluginDirs;

  const refusal =
    (model === undefined
      ? null
      : findOptionRefusal(agent.id, 'model', agent.spawnOptions.model, model)) ??
    (effort === undefined
      ? null
      : findOptionRefusal(agent.id, 'effort', agent.spawnOptions.effort, effort)) ??
    (pluginDirs === undefined || pluginDirs.length === 0
      ? null
      : findPluginDirsRefusal(agent.id, agent.spawnOptions.pluginDirs, pluginDirs));

  if (refusal !== null) {
    return refusal;
  }

  return {
    ok: true,
    overrides: {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(pluginDirs === undefined || pluginDirs.length === 0 ? {} : { pluginDirs }),
    },
  };
}

const MAX_VALUE_LENGTH = 200;

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

function findPluginDirsRefusal(
  agentID: string,
  option: SpawnOptionEntry | undefined,
  dirs: readonly string[],
): SpawnRefusal | null {
  if (option?.available !== true) {
    const reason =
      option?.supported === true
        ? "takes pluginDirs only on a target on the daemon's machine where it is installed"
        : 'takes no pluginDirs';

    return { ok: false, code: 'unsupported', message: `agent '${agentID}' ${reason}` };
  }

  const problem =
    dirs.map((dir) => findPluginDirProblem(dir)).find((found) => found !== null) ?? null;

  return problem === null ? null : { ok: false, code: 'bad_args', message: problem };
}
