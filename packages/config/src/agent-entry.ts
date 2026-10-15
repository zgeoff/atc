import type { AgentID } from '@atc/core';
import type { GatewayAuth, PluginDefinition } from '@atc/plugin-api';

/**
 * The agent CLI an entry drives, which decides the adapter behind it.
 */
export type AgentKind = 'claude' | 'codex' | 'grok';

/**
 * An MCP server a stock Claude session on a target that reaches impd's
 * broker reaches over HTTP, with the header that one of the session's
 * profiles sets for the server's host. The session sends a placeholder in
 * that header, and impd swaps the credential in on the host's side.
 */
export interface ClaudeMCPServer {
  readonly name: string;
  readonly url: string;
  readonly profile: string;
  readonly header: string;
}

/**
 * One agent atc offers: its id, how it appears in the spawn menu, the binary
 * and arguments it starts with, and, for a Claude entry, the settings, the
 * environment, and the backend and credential it runs against. A Claude entry
 * with a `baseURL` is a gateway; without one it is stock Claude, whose
 * `auth` holds profiles alone, for the subscription sign-in, and whose
 * `mcpServers` reach their hosts through those profiles. A Codex entry's
 * `auth` holds profiles alone too, for its ChatGPT sign-in, and its
 * `appServer` routes a local session through a Codex App Server of its own,
 * which lets the session take messages.
 */
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
}

/**
 * An agent entry a harness plugin parsed, with the problems that keep it
 * loaded, such as an MCP server left out of it.
 */
export interface ParsedAgentEntry {
  readonly entry: AgentEntry;
  readonly warnings: readonly string[];
}

/**
 * A harness plugin, whose config slice is one agent entry.
 */
export type HarnessPlugin = PluginDefinition<'harness', ParsedAgentEntry>;

/**
 * The part of a harness plugin that reading config takes: its id, the
 * fields its entries own, and its entry schema.
 */
export type AgentConfigPlugin = Pick<HarnessPlugin, 'id' | 'configFields' | 'configSchema'>;
