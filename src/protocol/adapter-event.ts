import type { AgentSessionID } from '../shared/agent-session-id';

/**
 * What an adapter makes of one hook event: the agent-neutral kind and the
 * fields the daemon and the store act on.
 */
export interface AdapterEvent {
  kind: 'started' | 'needs-input' | 'turn-done' | 'prompt-submitted' | 'ended' | 'heartbeat';
  agentSessionID?: AgentSessionID;
  message?: string;

  // True when a needs-input event is a permission prompt that only a person
  // can answer, as opposed to an idle or other notice. Absent otherwise.
  permissionPending?: boolean;

  // Fuller activity text than message: what the agent last said or was
  // asked, for briefing. Bounded by the adapter.
  detail?: string;

  // Opaque handle the adapter can later pull a session name from.
  nameSource?: string;

  // Claude resume-existence path. Distinct from nameSource: a naming
  // handle is not a resume gate.
  transcriptSource?: string;

  // The agent's whole final message for a finished turn; detail holds a bounded preview of it.
  result?: string;
}
