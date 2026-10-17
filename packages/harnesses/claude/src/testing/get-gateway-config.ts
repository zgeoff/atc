import type { Config } from '@atc/config';
import { getAgentEntry } from '@atc/test-utils';
import type { GatewayConfig } from '../config/collect-gateways';

export function getGatewayConfig(config: Pick<Config, 'agents'>, id: string): GatewayConfig {
  const { kind: _kind, ...entry } = getAgentEntry(config, id);

  if (entry.baseURL === undefined) {
    throw new Error(`the agent '${id}' has no baseURL`);
  }

  return { ...entry, baseURL: entry.baseURL };
}
