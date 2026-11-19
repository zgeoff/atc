import { z } from 'zod';
import { SCOPE_FIELD } from './scope-field';
import { SESSION_RECORD } from './session-entry';
import { SESSION_ID_BASE, SESSION_INPUT } from './session-input';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';

const SCOPE_ADD_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.extend({ scope: SCOPE_FIELD }).strict(),
  { io: 'input' },
);

const SESSION_ADOPT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    adopted: {
      type: 'boolean',
      description:
        "true once atc started or attached the session's terminal; it does not show the agent booted",
    },
  },
  required: ['adopted'],
};

const SESSION_AUTH_REBIND_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    revision: {
      type: 'number',
      description: "the revision the host's runtime auth binding holds after the rebind",
    },
    restartPending: {
      type: 'array',
      items: { type: 'string' },
      description:
        "the ids of the sessions on the host whose harness launched under an older revision and keeps that revision's settings until its next launch; empty when none",
    },
  },
  required: ['revision', 'restartPending'],
};

const SCOPE_ADD_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    record: { ...SESSION_RECORD, description: "the session's record as it stands after the call" },
  },
  required: ['record'],
};

const SESSION_STOP_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    stopped: {
      type: 'boolean',
      description:
        'true when the call stopped a live process, or put it to sleep inside a suspended host; false when the session had already exited',
    },
  },
  required: ['stopped'],
};

const SESSION_FORGET_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    confirmToken: {
      type: 'string',
      description:
        'on the first call on a target that destroys its hosts, the token the second call passes; the call forgot nothing',
    },
    expiresAt: {
      type: 'number',
      description: "when confirmToken stops working, in epoch milliseconds on the daemon's clock",
    },
    forgotten: { type: 'boolean', description: 'true once atc removed the session from the list' },
    destroyed: {
      type: 'boolean',
      description: 'true when the forget also destroyed the host the session owned',
    },
    workspace: {
      type: 'object',
      description: 'what the forget did with the workspace folder atc created for the session',
      properties: {
        outcome: {
          type: 'string',
          description:
            'removed: atc removed the folder; kept: the folder stays, and reasons says why; none: atc created no folder for the session, the folder was already gone, workspace cleanup is off, or the forget destroyed the host with the folder on it',
        },
        path: { type: 'string', description: 'the folder, on the host the session ran on' },
        found: {
          type: 'array',
          items: { type: 'string' },
          description:
            'on removed: what the checks found in the folder before atc removed it anyway, one line each; empty when they found nothing',
        },
        reasons: {
          type: 'array',
          items: { type: 'string' },
          description: 'on kept: one line for each reason atc kept the folder',
        },
      },
    },
  },
};

export const SESSION_LIFECYCLE_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_session_scope_add',
    annotations: TOOL_ANNOTATIONS.additive,
    scope: 'spawn',
    description:
      "Add worktrees, branches or pull requests to the scope a session's record holds. Returns { record }, the record as it stands after; a call that adds nothing returns it unchanged. atc checks every entry, held ones included, as the scope field states, and the first invalid one refuses the whole call with scope_invalid. Nothing is ever removed. A session on a sleeping host is refused with host_unavailable. Through atc mcp from inside a session, a session cannot add to its own scope or its parent's; a call through atc mcp --http or the gateway carries no caller session, so atc does not check it.",
    inputSchema: SCOPE_ADD_INPUT,
    outputSchema: SCOPE_ADD_OUTPUT,
  },
  {
    name: 'atc_session_update',
    annotations: TOOL_ANNOTATIONS.additive,
    scope: 'message',
    description:
      "Rename, pin, or detach a session. A name has three sources, strongest first: the agent's own /rename, a name given at spawn or set here, and an auto-summary. A name set here replaces any name except one the agent set: then the call keeps the agent's name and returns text that starts \"updated, not renamed\" and states why. Otherwise it returns the text updated whenever the session exists, a call that changes nothing included, so read the session with atc_session_get to see the change. A pinned session cannot be forgotten and leads the TUI's list; atc_sessions_list keeps creation order. A sub-session follows its parent: it pins with the parent, so while the parent is pinned only a call from inside the parent can forget it; it stops when its live parent stops, and a remote client reaches it only when the client reaches the parent and every sub-session of it. A pin set on a sub-session itself stops every caller from forgetting it, its parent included, and keeps it listed as a top-level session when its parent is forgotten. parent null detaches a sub-session: it becomes top-level, so its own pin and forget apply and the former parent keeps its pin. Detaching a top-level session changes nothing. A session cannot move under another parent. A detach or a pin of a sub-session that runs in its parent's host is refused with bad_args, since that host sleeps and is destroyed with its parent, and nothing else in that call applies, a rename included.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        name: { type: 'string', description: 'New display name; omit to keep' },
        pinned: { type: 'boolean', description: 'Pin or unpin; omit to keep' },
        parent: {
          type: 'null',
          description:
            'null detaches the session from its parent and makes it top-level; omit to keep. No other value is taken.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'atc_session_stop',
    annotations: TOOL_ANNOTATIONS.destructive,
    scope: 'kill',
    description:
      "Stop a session's agent process. The session stays in the list as exited; atc_session_forget removes it. Returns { stopped: true } when the call stopped or suspended a live process, and { stopped: false } when the session had already exited, which changes nothing. A live session's live sub-sessions stop with it; stopping an exited session leaves its sub-sessions running. On a target that suspends its hosts (capabilities.suspend in atc_spawn_options_get) the host is suspended, not destroyed: a session that owns its host puts the host to sleep with every session on it, their processes kept for a later atc_session_adopt, and the call fails with host_leased or host_unavailable while the host cannot sleep. A sub-session that shares its parent's host is killed instead, and so is a sub-session on a host of its own when its parent stops and that host fails to suspend. An unknown id is refused with no_such_session.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_STOP_OUTPUT,
  },
  {
    name: 'atc_session_forget',
    annotations: TOOL_ANNOTATIONS.destructive,
    scope: 'kill',
    description:
      "Remove a session from the list for good. On a target that destroys its hosts (capabilities.destroy in atc_spawn_options_get) this destroys the host and everything on it, so it takes two calls: the first changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token, returns { forgotten: true, destroyed: true }. The second call spends the token before it destroys anything, so a destroy that fails needs a new token from a call without one; a spent, expired or unknown token is refused with confirm_token_invalid. A sub-session that shares its parent's host needs the token too but keeps the host (destroyed: false). On any other target one call returns { forgotten: true, destroyed: false }. A forget also deletes the workspace folder atc cloned for the session, unless it holds work that exists nowhere else (an uncommitted or untracked file, a file git status skips through an assume-unchanged or skip-worktree flag, a stash, or a commit that no remote-tracking ref holds, a commit on a detached HEAD included, a linked worktree, or a submodule), another listed session runs inside it, its host does not answer the check, or atc cannot see the session's process exit (a headless turn included); then the folder stays, and workspace.reasons in the result says why. workspace.outcome is removed, kept, or none (no folder atc cloned, a folder already gone, cleanup off in the daemon config, or a host the forget destroyed). A folder atc did not clone is never deleted. The daemon config can turn this off, or make it delete every folder atc cloned whatever it holds. Refused: a live session unless stop is true, a pinned session, and a sub-session of a pinned session (unpin it, or detach the sub-session with parent null, through atc_session_update first). One exception: a call from inside a session may forget its own sub-sessions while that session is pinned, but not one that carries a pin of its own. Live sub-sessions on a host that survives move to the top level, and so do sub-sessions with a pin of their own and sub-sessions on a host of their own. A sub-session asleep in its parent's host is refused with unsupported_operation (problem host_asleep): adopt it, or forget its parent, first.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id' },
        confirmToken: {
          type: 'string',
          minLength: 1,
          description: 'The token an earlier call on the same session returned',
        },
        stop: {
          type: 'boolean',
          description: 'Stop the session when it is live; omit or false refuses a live session',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
    outputSchema: SESSION_FORGET_OUTPUT,
  },
  {
    name: 'atc_session_adopt',
    annotations: TOOL_ANNOTATIONS.agentFacingDestructive,
    scope: 'spawn',
    description:
      "Start a terminal for a session that has none, resuming its agent session, as the TUI's P key does: a session a restore left without a terminal, an exited session such as one atc_session_stop stopped, or one that runs headless. A headless turn still running stops before the terminal is set up, and it stays stopped when that setup is then refused, such as with auth_rebind_required: the session is left with neither the turn nor a terminal, so adopt a session that runs a headless turn only when you mean to end that turn. On a target that suspends its hosts the host wakes first, every other session asleep on it revives, and a harness still running there is attached instead of started again, unless it launched under an older auth revision than its host holds, which ends it and starts a new one that resumes the agent session; the call returns after those revives. Use it after atc_session_auth_rebind for a session whose restore was refused with auth_rebind_required. Returns { adopted: true } once the terminal starts; that does not show the agent booted, so check with atc_session_get or atc_terminal_read. Refused with session_dead when atc finds nothing to resume, an unknown session id included, which leaves the session as it was. A pin never refuses an adopt. A remote client is refused with no_such_session for a session whose tree runs on a target outside its reach, as atc_session_stop and atc_session_forget refuse it. Refused with no_such_session when the session already has a terminal or another adopt of it runs; that refusal, and a refusal of the session's target, can come after a running headless turn stopped. A retry once the terminal runs is refused and starts nothing.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_ADOPT_OUTPUT,
  },
  {
    name: 'atc_session_auth_rebind',
    annotations: TOOL_ANNOTATIONS.destructive,
    scope: 'spawn',
    description:
      "Bind the runtime auth of a session's host to the auth profiles its agent selects now, at the next revision. Use it when atc_session_adopt or a restore is refused with auth_rebind_required because the agent's auth profiles changed, or with auth_blocked after a revoke or a failed rebind; then start the session with atc_session_adopt, since a rebind starts nothing. The host gains every grant the agent's auth profiles now select and loses every grant they no longer select, for every session on that host. A harness keeps the settings it launched with until its next launch, and a rebind restarts none: restart a running session with atc_session_stop then atc_session_adopt. Returns { revision, restartPending }: the new revision, and the sessions on the host whose harness still holds an older revision's settings. Open to the daemon's owner only: a remote client is refused with unauthorized. Refused with unsupported_operation for a host with no auth binding, or for an agent that takes no credential from the target's broker, such as one whose auth block was dropped from the config: put the block back, or forget the session. Refused with auth_blocked while the binding is in another state, such as a revoke still pending. Launches on the host are refused with auth_blocked while a rebind runs. A rebind whose grant step fails leaves the host blocked at its old revision until a rebind succeeds; one refused before that step leaves the binding as it was. Each call that succeeds moves the binding to a new revision, a retry included.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_AUTH_REBIND_OUTPUT,
  },
  {
    name: 'atc_session_mark_read',
    annotations: TOOL_ANNOTATIONS.additive,
    scope: 'message',
    description: "Clear a session's unread flag. Nothing else changes.",
    inputSchema: SESSION_INPUT,
  },
];
