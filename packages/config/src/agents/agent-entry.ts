import type { AgentID } from '@atc/core';
import type { GatewayAuth, PluginDefinition } from '@atc/plugin-api';

export type AgentKind = 'claude' | 'codex' | 'grok';

export interface ClaudeMCPServer {
  readonly name: string;
  readonly url: string;
  readonly profile: string;
  readonly header: string;
}

export interface AgentEntry {
  readonly id: AgentID;
  readonly kind: AgentKind;
  readonly label: string;
  readonly mark: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly baseURL?: string;
  readonly apiKeyHelper?: string;
  readonly auth?: GatewayAuth;
  readonly mcpServers?: readonly ClaudeMCPServer[];
  readonly appServer?: boolean;

  // Claude only: plugin folders every session of the entry loads, each an
  // absolute path or one under the home with a leading ~/.
  readonly pluginDirs?: readonly string[];
}

export interface ParsedAgentEntry {
  readonly entry: AgentEntry;
  readonly warnings: readonly string[];
}

export type HarnessPlugin = PluginDefinition<'harness', ParsedAgentEntry>;

export type AgentConfigPlugin = Pick<HarnessPlugin, 'id' | 'configFields' | 'configSchema'>;
