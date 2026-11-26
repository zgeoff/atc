import type { HooksConfig } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';

export interface ReloadedConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly defaultAgent: AgentID;

  // absent keeps the daemon's current default
  readonly defaultTarget?: string | null;
  readonly hooks: HooksConfig;
}

export interface DaemonHandle {
  readonly stop: () => Promise<void>;

  readonly [Symbol.asyncDispose]: () => Promise<void>;

  readonly countClients: () => number;

  readonly countEventWaiters: () => number;

  readonly listenPort: number | null;

  readonly refreshTokens: () => void;

  readonly reloadConfig: (config: ReloadedConfig) => readonly string[];
}
