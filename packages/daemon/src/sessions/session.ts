import type { AgentID } from '@atc/core';
import type { HarnessHandle } from '@atc/plugin-api';
import type { SessionState } from '@atc/protocol';
import type {
  AgentSessionID,
  GrantScope,
  SessionID,
  SessionLifecycle,
  SessionWorkspace,
} from '@atcx/contract';

export interface Session {
  id: SessionID;
  name: string;
  cwd: string;
  kind: 'pty' | 'headless';

  pty: HarnessHandle | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  lastDetail?: string;

  permissionPending?: boolean;

  // Kept out of the fleet row, since a revive brings the session back done.
  turnFailed?: boolean;
  agentSessionID?: AgentSessionID;
  agent: AgentID;
  transcriptSource?: string;
  pinned: boolean;

  lastAttachedAt: number;

  // Equals the session directory when that directory is outside any repository.
  repoRoot: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;

  // A sub-session never owns another, so nesting is one level deep.
  parent: SessionID | null;

  spawner: SessionID | null;

  atcAccess?: readonly GrantScope[];

  prompt?: string;

  result?: string;

  transcriptPath?: string;

  model?: string;
  effort?: string;

  pluginDirs?: readonly string[];

  target: string;
  targetIdentity: string;

  workspace?: SessionWorkspace;

  withheldEnv: readonly string[];

  desired: SessionLifecycle['desired'];
  vm: SessionLifecycle['vm'];
  attachment: SessionLifecycle['attachment'];

  suspended: boolean;

  // The session whose host the harness runs on: its own id, or its
  // parent's when the parent runs on the same target, so one host serves a
  // top-level session and the sub-sessions beside it.
  hostKey: SessionID;

  bridgeEpoch: number;

  // The runtime auth revision the session's latest harness launched under;
  // absent for a harness that takes no credential from impd's broker.
  authRevision?: number;

  agentHome?: string | undefined;

  trustedRoot?: string;

  // The code and message of the refusal that ended the last restore attempt at a terminal.
  // It applies only while the session's listed message still equals this message.
  restoreRefusal?: { readonly code: string; readonly message: string };
}
