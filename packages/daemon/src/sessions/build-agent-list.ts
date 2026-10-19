import type { AgentAdapter } from '@atc/plugin-api';
import type { SpawnOptionSpec } from '@atc/protocol';

interface AgentCapabilities {
  // Whether some target can start a session of the agent.
  readonly spawn: boolean;
  readonly readTranscript: boolean;

  // Whether a session takes inbox messages through a tap.
  readonly message: boolean;
  readonly attach: boolean;
  readonly screen: boolean;
  readonly input: boolean;
}

export interface AgentEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: string;

  // Whether the agent's binary resolves, on PATH or at its configured path.
  readonly installed: boolean;

  // Whether the agent takes its credential from impd's broker on a target
  // whose entry has `brokerAuth`.
  readonly brokerAuth: boolean;

  // Whether it starts only there. False for an agent that starts on any
  // other target under the sign-in that target's host holds.
  readonly brokerRequired: boolean;

  // The targets a spawn of the agent can start on: none when its starts are
  // all refused, only those that reach impd's broker when it starts only
  // there, and only a remote target when its binary is missing here.
  readonly spawnTargets: readonly string[];
  readonly capabilities: AgentCapabilities;
  readonly models: Readonly<Record<string, string>> | null;
  readonly spawnOptions: SpawnOptionEntries;
}

// A spawn option as `agents.list` shows it: the agent's own spec, plus
// whether a spawn can pass it now. Only the supported option of an agent
// some target can start is available.
export interface SpawnOptionEntry extends SpawnOptionSpec {
  readonly available: boolean;
}

// A target as the agent list weighs it.
export interface AgentListTarget {
  readonly id: string;

  // Whether its provider runs the agent on a machine other than the
  // daemon's, so the agent's binary need not resolve here.
  readonly remote: boolean;

  // Whether its provider reaches impd's credential broker.
  readonly brokerAuth: boolean;
}

interface SpawnOptionEntries {
  readonly model: SpawnOptionEntry;
  readonly effort: SpawnOptionEntry;

  // the daemon lists it for every agent; optional so a list scoped to a
  // principal keeps the shape it was given
  readonly pluginDirs?: SpawnOptionEntry;
}

export function buildAgentList(
  adapters: readonly AgentAdapter[],
  isInstalled: (bin: string) => boolean,
  targets: readonly AgentListTarget[],
): AgentEntry[] {
  return adapters.map((adapter) => {
    const profile = adapter.profile;
    const installed = profile === undefined ? false : isInstalled(profile.bin);
    const selection = adapter.findAuthSelection?.() ?? null;
    const brokerRequired = selection?.brokerRequired ?? false;
    const refused = (adapter.findSpawnRefusal?.() ?? null) !== null;
    const configuresPluginDirs = (profile?.pluginDirs ?? []).length > 0;

    const spawnTargets = refused
      ? []
      : targets
          .filter((target) => installed || target.remote)
          .filter((target) => !brokerRequired || target.brokerAuth)
          .filter((target) => !configuresPluginDirs || !target.remote)
          .map((target) => target.id);

    const spawnable = spawnTargets.length > 0;

    // a plugin folder is checked on the daemon's machine, so only a target
    // that runs the agent there takes one
    const takesPluginDirs = targets.some(
      (target) => !target.remote && spawnTargets.includes(target.id),
    );

    // only the profile and what the interface offers: no environment value, credential,
    // helper command, or base URL may reach a client
    return {
      id: adapter.id,
      label: profile?.label ?? adapter.id,
      kind: profile?.kind ?? adapter.id,
      installed,
      brokerAuth: selection !== null,
      brokerRequired,
      spawnTargets,
      capabilities: {
        spawn: spawnable,
        readTranscript: adapter.parseTranscriptLine !== undefined,
        message: adapter.takesMessages,

        // every session runs in a PTY
        attach: true,
        screen: true,
        input: true,
      },
      models: profile?.models ?? null,
      spawnOptions: {
        model: buildSpawnOptionEntry(profile?.spawnOptions.model, spawnable),
        effort: buildSpawnOptionEntry(profile?.spawnOptions.effort, spawnable),
        pluginDirs: buildSpawnOptionEntry(profile?.spawnOptions.pluginDirs, takesPluginDirs),
      },
    };
  });
}

// A stand-in adapter declares no spawn options, so it takes none.
const NO_SPAWN_OPTION: SpawnOptionSpec = {
  supported: false,
  values: null,
  examples: [],
  default: null,
  backendEffect: null,
  note: null,
};

function buildSpawnOptionEntry(
  spec: SpawnOptionSpec | undefined,
  spawnable: boolean,
): SpawnOptionEntry {
  const resolved = spec ?? NO_SPAWN_OPTION;

  return { ...resolved, available: spawnable && resolved.supported };
}
