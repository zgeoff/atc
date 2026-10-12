import type { Config } from '../shared/config';
import type { AgentAdapter, ClaudeHostPaths } from './agent-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import { GatewayAdapter } from './gateway-adapter';
import { GrokAdapter } from './grok-adapter';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';

/**
 * Where the Claude and gateway adapters write their settings file and their
 * copy of the atc-bridge mod, and the home whose Claude config they read. A
 * field left out takes atc's state folder or the running user's home.
 */
interface AgentAdapterPaths extends ClaudeHostPaths {
  readonly bridgeTarget?: string;
}

/**
 * One adapter per registry entry, in registry order. A Claude entry with a
 * base URL is a gateway, and one without is stock Claude.
 */
export function buildAgentAdapters(
  config: Config,
  headlessRun: ClaudeHeadlessRun | null = null,
  paths: AgentAdapterPaths = {},
): AgentAdapter[] {
  const { bridgeTarget, ...hostPaths } = paths;

  return config.agents.map((entry): AgentAdapter => {
    if (entry.kind === 'codex') {
      return new CodexAdapter(entry, config);
    }

    if (entry.kind === 'grok') {
      return new GrokAdapter(entry);
    }

    if (entry.baseURL === undefined) {
      return new ClaudeAdapter(entry, config, headlessRun, bridgeTarget, hostPaths);
    }

    return new GatewayAdapter(
      { ...entry, baseURL: entry.baseURL },
      config,
      headlessRun,
      bridgeTarget,
      hostPaths,
    );
  });
}
