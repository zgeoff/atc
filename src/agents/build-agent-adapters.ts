import type { Config } from '../shared/config';
import type { AgentAdapter } from './agent-adapter';
import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import { GatewayAdapter } from './gateway-adapter';
import { GrokAdapter } from './grok-adapter';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';

/**
 * One adapter per registry entry, in registry order. A Claude entry with a
 * base URL is a gateway, and one without is stock Claude.
 */
export function buildAgentAdapters(
  config: Config,
  headlessRun: ClaudeHeadlessRun | null = null,
): AgentAdapter[] {
  return config.agents.map((entry): AgentAdapter => {
    if (entry.kind === 'codex') {
      return new CodexAdapter(entry, config);
    }

    if (entry.kind === 'grok') {
      return new GrokAdapter(entry);
    }

    if (entry.baseURL === undefined) {
      return new ClaudeAdapter(entry, config, headlessRun);
    }

    return new GatewayAdapter({ ...entry, baseURL: entry.baseURL }, config, headlessRun);
  });
}
