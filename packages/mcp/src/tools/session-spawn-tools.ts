import { REQUEST_PARAM_SCHEMAS } from '@atcx/contract';
import { z } from 'zod';
import { buildSpawnDescriptions } from './build-spawn-descriptions';
import { DAEMON_FIELD } from './daemon-field';
import { NO_INPUT } from './no-input';
import { IDEMPOTENCY_KEY_FIELD } from './parse-idempotency-key';
import { SCOPE_FIELD } from './scope-field';
import { SESSION_ENTRY, SESSION_ENTRY_PROPERTIES } from './session-entry';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';

const SPAWN_SCHEMA = REQUEST_PARAM_SCHEMAS['session.spawn'];
const SPAWN_AGENT_DESCRIPTION = buildSpawnDescriptions(null).agent;

const SPAWN_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    daemon: DAEMON_FIELD,
    cwd: SPAWN_SCHEMA.shape.cwd.describe(
      "Absolute path of the working directory. Required, except with a git workspace: omit it there and atc picks a new directory under the target user's home, ~/.local/share/atc/workspaces/<repo>-<ref>-<short sha> unless the config sets another root, adding -2, -3, and so on when that directory exists. The session's cwd in the result holds the path it landed in.",
    ),
    name: SPAWN_SCHEMA.shape.name.describe(
      'Session name; defaults to the basename of the working directory, without the -2, -3 suffix of a directory atc picked',
    ),
    prompt: SPAWN_SCHEMA.shape.prompt.describe('First message for the session'),
    agent: SPAWN_SCHEMA.shape.agent.describe(SPAWN_AGENT_DESCRIPTION),
    model: SPAWN_SCHEMA.shape.model.describe(
      "Model for the new session: an alias or a full model name, at most 200 characters, never starting with '-'. It reaches the agent CLI as its own argument. Refused when the agent takes no model; spawnOptions.model in atc_spawn_options_get holds each agent's support, default, and examples. Omit it to keep the agent's configured default.",
    ),
    effort: SPAWN_SCHEMA.shape.effort.describe(
      "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_spawn_options_get. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
    ),
    pluginDirs: SPAWN_SCHEMA.shape.pluginDirs.describe(
      "Claude Code plugin folders this session alone loads, at most 32, each an absolute path or one that starts with ~/ on the atc daemon's machine, without a .. segment; each reaches the CLI as --plugin-dir. They load after the folders the agent's config sets, which still load; the daemon reads the config's folders when it starts, so a change to them takes effect only after the atc daemon restarts. Refused when the agent takes none (spawnOptions.pluginDirs in atc_spawn_options_get), on a target that runs the agent on another machine, and when any path, the config's included, does not exist or is not a folder; the refusal names the path. Every restart of the session, after a daemon restart included, loads them again; a restart, an eject or a headless turn that finds a folder gone is refused the same way and leaves the session as it was.",
    ),
    target: SPAWN_SCHEMA.shape.target.describe(
      'Execution target for the new session, one of the target ids in atc_spawn_options_get. Omit it to run on the default target (spawnDefaults.target). An unknown or unavailable target is refused; atc never runs the session on another target instead.',
    ),
    workspace: SPAWN_SCHEMA.shape.workspace.describe(
      "Where the session's working directory comes from. Omit it to run the session in cwd as it stands. With it, atc materializes a clean checkout into cwd on the target, which must not exist yet, or for a git source without cwd into a directory atc picks: {kind:'path', path, allowDirty?} checks out the pushed HEAD of a git checkout on the atc host, leaving its uncommitted and untracked changes behind with a warning, or refusing them when allowDirty is 'refuse'; {kind:'git', url, ref or sha, credentialRef?} checks out a branch, tag, or full commit of a repository, with credentialRef {kind:'env', name} naming the atc daemon's environment variable that holds its token. A directory outside git runs in place only on a target on the atc host itself (provider local-pty), with cwd equal to its path. Submodules and Git LFS are refused, and so is a URL that carries a credential.",
    ),
    trustClonedWorkspace: SPAWN_SCHEMA.shape.trustClonedWorkspace.describe(
      "Trust the exact verified clone for this launch. An explicit true or false overrides the configured target trustClonedWorkspace default; omitting both keeps trust off. Requires a workspace source and either stock Claude on the local target, which adds trust for the clone root alone to the user's Claude config, or, on a target that signs sessions in through a broker (brokerAuth true in atc_spawn_options_get), an agent signed in through the broker whose isolated guest config takes trust, such as a brokered Claude gateway or stock Claude; other launches are refused, and the refusal lists the ones that work. Accepts repository configuration and helpers without changing tool permission mode. Existing guest config is preserved.",
    ),
    scope: SCOPE_FIELD.optional(),
    detached: z
      .boolean()
      .optional()
      .describe(
        'Spawn a top-level session with no parent, whose pin and forget stand on their own. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, stopped with it, and forgettable while it is pinned only by a call from inside it. atc_session_update with parent null detaches a sub-session later.',
      ),
    atcAccess: SPAWN_SCHEMA.shape.atcAccess.describe(
      "Give the new session atc tools of its own, which reach only the session itself, its sub-sessions and the sessions they spawn, plus its parent for messages alone. Each scope opens the tools of that scope: read lists and reads those sessions, their terminals, transcripts, notes and answers; message sends them messages, renames, pins, detaches and marks them read, and sends the parent messages; spawn starts sub-sessions, always on the new session's own target, and types into or answers menus in the sessions it reaches; kill stops or forgets its sub-sessions, never itself. The new session's own spawns take no workspace, so it checks its work out itself. Omit it for a session with no atc tools. It takes a target that runs the agent on another machine and a Claude Code agent; any other spawn with it is refused with bad_args, since a session on the atc daemon's machine reaches atc as the daemon's owner. A session grants only scopes it holds: a spawn from a session with atc access that names a scope that session lacks is refused with unauthorized, and so is a sub-session that would share a host whose session lacks the scope. A remote client gets insufficient_scope for a scope its token lacks. The access stays across daemon restarts and while the session's host sleeps, and no call changes it while the session lives.",
    ),
    idempotencyKey: IDEMPOTENCY_KEY_FIELD,
  }),
  { io: 'input' },
);

const SESSIONS_LIST_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      description: 'the sessions, sub-sessions included, in the order atc holds them',
      items: SESSION_ENTRY,
    },
    daemons: {
      type: 'array',
      description: "under the gateway, each daemon's state",
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "the daemon's name" },
          state: {
            type: 'string',
            description:
              'up, down, unauthorized, changed, mismatched (it runs an atc version the gateway cannot serve) or refused (it answered with an error); a later daemon may add a value',
          },
        },
        required: ['name', 'state'],
      },
    },
  },
  required: ['sessions'],
};

const SPAWN_OUTPUT: Readonly<Record<string, unknown>> = {
  ...SESSION_ENTRY,
  properties: {
    ...SESSION_ENTRY_PROPERTIES,
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'what the workspace left behind, such as uncommitted changes; absent when there is none, and on a retry with the same idempotencyKey',
    },
  },
};

export const SESSION_SPAWN_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_sessions_list',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "List the sessions atc hosts, or every daemon's sessions under the gateway, with each one's id, name, directory, agent, state, unread and pinned flags, and the parent of each sub-session. For one session's pending prompt and last reply, use atc_session_get. state is running (the agent is working), needs_you (the agent asked for a person, such as a permission prompt), done (the turn ended; it waits for the next prompt) or exited (no live process: it ended, or it sleeps inside a suspended host). The list keeps the order atc holds the sessions in and does not put pinned sessions first. A remote client sees only the sessions whose whole tree it reaches. Under the gateway, daemons holds each daemon's state, so a daemon that is down never reads as one with no sessions.",
    inputSchema: NO_INPUT,
    outputSchema: SESSIONS_LIST_OUTPUT,
  },
  {
    name: 'atc_session_spawn',
    annotations: TOOL_ANNOTATIONS.agentFacing,
    scope: 'spawn',
    description: buildSpawnDescriptions(null).tool,
    inputSchema: SPAWN_INPUT,
    outputSchema: SPAWN_OUTPUT,
    requires: { inputs: { daemon: 'fleet.daemons' } },
  },
];
