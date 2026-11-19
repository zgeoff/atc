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

  // Attaching or a screen judgment leaves it set. Only a later agent event closes the prompt.
  permissionPending?: boolean;
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

  // The session the spawn request came from, which can be a sub-session spawning a sibling.
  // Null when the request came from outside every session.
  spawner: SessionID | null;

  atcAccess?: readonly GrantScope[];

  prompt?: string;

  result?: string;

  // A restored path never changes whether a revive is allowed.
  transcriptPath?: string;

  // Absent means the agent's configured default. Every revive passes both again.
  model?: string;
  effort?: string;

  // Absolute paths on the daemon's machine. Every revive loads them again.
  pluginDirs?: readonly string[];

  // Every revive runs on the same target, and only while the target still has the identity it
  // had when the session started there.
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

  // The epoch of the session's latest harness start or attach, which the
  // daemon's bridge to that harness is bound to; 0 before the first.
  bridgeEpoch: number;

  // The runtime auth revision the session's latest harness launched under;
  // absent for a harness that takes no credential from impd's broker.
  authRevision?: number;

  agentHome?: string | undefined;

  trustedRoot?: string;

  // The refusal a restore's last try at a terminal ended with, when no
  // later try lifts it: its code, and the message the session listed with.
  // It holds only while the session still lists that message.
  restoreRefusal?: { readonly code: string; readonly message: string };
}
