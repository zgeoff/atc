import type { AgentAdapter, HostCredentials } from '@atc/plugin-api';
import type { SpawnOptionSpec } from '@atcx/contract';
import { buildHarnessAuthDecision } from '../auth/build-harness-auth-decision';

interface AgentCapabilities {
  readonly spawn: boolean;
  readonly readTranscript: boolean;

  readonly message: boolean;
  readonly attach: boolean;
  readonly screen: boolean;
  readonly input: boolean;
}

export interface SpawnOptionEntry extends SpawnOptionSpec {
  readonly available: boolean;
}

interface SpawnOptionEntries {
  readonly model: SpawnOptionEntry;
  readonly effort: SpawnOptionEntry;
  readonly pluginDirs: SpawnOptionEntry;
}

export interface AgentEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: string;

  readonly installed: boolean;

  readonly brokerAuth: boolean;

  readonly brokerRequired: boolean;

  readonly spawnTargets: readonly string[];
  readonly capabilities: AgentCapabilities;
  readonly models: Readonly<Record<string, string>> | null;
  readonly spawnOptions: SpawnOptionEntries;
}

export interface AgentListTarget {
  readonly id: string;

  readonly remote: boolean;

  readonly credentials: HostCredentials;
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
          .filter(
            (target) => buildHarnessAuthDecision(adapter, target.credentials).kind !== 'refused',
          )
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
