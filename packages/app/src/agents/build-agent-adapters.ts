import type { Config } from '@atc/config/config';
import { ClaudeAdapter } from '@atc/harness-claude/claude-adapter';
import type { ClaudeHostPaths } from '@atc/harness-claude/claude-host-paths';
import { GatewayAdapter } from '@atc/harness-claude/gateway/gateway-adapter';
import type { ClaudeHeadlessRun } from '@atc/harness-claude/headless/make-claude-headless-runner';
import { CodexAdapter } from '@atc/harness-codex/codex-adapter';
import { GrokAdapter } from '@atc/harness-grok/grok-adapter';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import type { HostServices } from '@atc/plugin-api/host-services';

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
 * base URL is a gateway, and one without is stock Claude. The Claude-family
 * adapters run the atc CLI that the host's argv runs.
 */
export function buildAgentAdapters(
  config: Config,
  host: Pick<HostServices, 'atcArgv'>,
  headlessRun: ClaudeHeadlessRun | null = null,
  paths: AgentAdapterPaths = {},
): AgentAdapter[] {
  const options = { ...paths, headlessRun };

  return config.agents.map((entry): AgentAdapter => {
    if (entry.kind === 'codex') {
      return new CodexAdapter(entry, config);
    }

    if (entry.kind === 'grok') {
      return new GrokAdapter(entry);
    }

    if (entry.baseURL === undefined) {
      return new ClaudeAdapter(entry, config, host, options);
    }

    return new GatewayAdapter({ ...entry, baseURL: entry.baseURL }, config, host, options);
  });
}
