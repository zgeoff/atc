import type { AgentID } from '@atc/core/agent-id';
import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { SessionID } from '@atc/core/session-id';
import type { HarnessHandle } from '@atc/plugin-api/execution-provider';
import type { SessionLifecycle } from '@atc/protocol/session-lifecycle';
import type { SessionState } from '@atc/protocol/session-state';
import type { SessionWorkspace } from '@atc/protocol/session-workspace';

export interface Session {
  id: SessionID;
  name: string;
  cwd: string;
  kind: 'pty' | 'headless';

  // The running harness its execution provider handed back, or null when
  // the session has no terminal.
  pty: HarnessHandle | null;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  lastDetail?: string;

  // True while the session's agent reported a permission prompt that no
  // later event has closed. Attaching or a screen judgment leaves it set.
  permissionPending?: boolean;
  agentSessionID?: AgentSessionID;
  agent: AgentID;
  transcriptSource?: string;
  pinned: boolean;

  // when the operator last attached, so lists can lead with the sessions
  // they were just working in; starts at creation time.
  lastAttachedAt: number;

  // the repository this session's directory belongs to (the directory
  // itself outside any repository), for clustering in the overlay.
  repoRoot: string;

  // who last named this session: the agent's own rename beats everything, a
  // user-typed spawn name beats auto-summaries.
  namedBy: 'user' | 'auto' | 'agent';
  createdAt: number;

  // The session that spawned this one as a sub-session; null for a
  // top-level session. One level deep: a sub-session never owns another.
  parent: SessionID | null;

  // the prompt the session was spawned with
  prompt?: string;

  // the agent's final message from its latest finished turn, capped in size
  result?: string;

  // the transcript file the agent's hooks last reported. Kept apart from the
  // resume check so a restored path never changes whether a revive is allowed.
  transcriptPath?: string;

  // the model and effort the session was spawned with; absent leaves the
  // agent's configured default, and every revive passes them again.
  model?: string;
  effort?: string;

  // the execution target the session runs on, and the identity it had
  // when the session started there; every revive runs there too, and only
  // while the target keeps that identity.
  target: string;
  targetIdentity: string;

  // what the working directory was materialized from, when the spawn
  // carried a workspace source
  workspace?: SessionWorkspace;

  // the environment variable names every harness the session starts goes
  // without: the materialization's credential and askpass context
  withheldEnv: readonly string[];

  // What the operator asked of the harness, the last state seen of its
  // host, and the daemon's connection to its output.
  desired: SessionLifecycle['desired'];
  vm: SessionLifecycle['vm'];
  attachment: SessionLifecycle['attachment'];

  // Whether the harness is kept inside a sleeping host, for a revive to
  // find as it was.
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
}
