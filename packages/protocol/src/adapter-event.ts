import type { AgentSessionID } from '@atcx/contract';

export interface AdapterEvent {
  kind: 'started' | 'needs-input' | 'turn-done' | 'prompt-submitted' | 'ended' | 'heartbeat';
  agentSessionID?: AgentSessionID;
  message?: string;

  permissionPending?: boolean;

  turnFailed?: boolean;

  detail?: string;

  nameSource?: string;

  transcriptSource?: string;

  result?: string;
}
