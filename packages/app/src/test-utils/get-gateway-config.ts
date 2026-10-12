import type { GatewayConfig } from '../shared/collect-gateways';
import type { Config } from '../shared/config';
import { getAgentEntry } from './get-agent-entry';

/**
 * The gateway a parsed config holds under an agent id: a Claude entry with a
 * base URL, without the registry's `kind`, which a gateway does not carry.
 * Throws when the config holds no such agent or the entry has no base URL.
 */
export function getGatewayConfig(config: Pick<Config, 'agents'>, id: string): GatewayConfig {
  const { kind: _kind, ...entry } = getAgentEntry(config, id);

  if (entry.baseURL === undefined) {
    throw new Error(`the agent '${id}' has no baseURL`);
  }

  return { ...entry, baseURL: entry.baseURL };
}
