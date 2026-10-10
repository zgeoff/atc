import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { isRecord } from '../src/shared/report';
import { setupMCPHome } from '../src/test-utils/setup-mcp-home';
import { startMCPStdio } from '../src/test-utils/start-mcp-stdio';

function setupTest() {
  const mcpHome = setupMCPHome();

  return { home: mcpHome.home, claudeBin: mcpHome.claudeBin, grokBin: mcpHome.grokBin };
}

test('it answers initialize with the requested protocol version and its server name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });

  const response = await mcp.sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test' },
  });

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'atc', version: expect.toBeString() },
    },
  });
});

test('it answers an unsupported protocol version with the latest supported one', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });

  const response = await mcp.sendRequest('initialize', {
    protocolVersion: '2099-01-01',
    capabilities: {},
    clientInfo: { name: 'test' },
  });

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'atc', version: expect.toBeString() },
    },
  });
});

test('it answers an unknown rpc method with a json-rpc error', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('bogus/method');

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32_601, message: "unknown method 'bogus/method'" },
  });
});

test('it lists the fleet tools', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('tools/list');

  expect(response).toMatchInlineSnapshot(`
    {
      "id": 2,
      "jsonrpc": "2.0",
      "result": {
        "tools": [
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List the sessions atc hosts, or every daemon's sessions under the gateway, with each one's id, name, directory, agent, state, unread and pinned flags. state is running (the agent is working), needs_you (the agent asked for a person, such as a permission prompt), done (the turn ended; it waits for the next prompt) or exited (no live process). For one session's pending prompt and last reply, use atc_session_get. Under the gateway, daemons holds each daemon's state, so a daemon that is down never reads as one with no sessions.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_sessions_list",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes, and anything else is refused before anything starts. Called from inside an atc session, the new session is a sub-session of the caller (listed under it, stopped with it) unless detached is true. A directory the agent has not trusted opens its folder-trust dialog, which only a person can answer in the TUI; trustClonedWorkspace trusts a fresh workspace clone. A retry with the same idempotencyKey and arguments returns the first result.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "agent": {
                  "description": "Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_spawn_options_get returns the current list.",
                  "minLength": 1,
                  "type": "string",
                },
                "cwd": {
                  "description": "Absolute path of the working directory. Required, except with a git workspace: omit it there and atc picks a new directory under the target user's home, ~/.local/share/atc/workspaces/<repo>-<ref>-<short sha> unless the config sets another root, adding -2, -3, and so on when that directory exists. The session's cwd in the result holds the path it landed in.",
                  "minLength": 1,
                  "type": "string",
                },
                "detached": {
                  "description": "Spawn a top-level session. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, stopped with it.",
                  "type": "boolean",
                },
                "effort": {
                  "description": "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_spawn_options_get. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
                  "type": "string",
                },
                "idempotencyKey": {
                  "description": "A key, unique to this call, that makes a retry safe: retrying with the same key and arguments returns the first answer instead of acting again, and the same key with different arguments is refused as idempotency_conflict. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters",
                  "maxLength": 180,
                  "minLength": 1,
                  "type": "string",
                },
                "model": {
                  "description": "Model for the new session: an alias or a full model name, at most 200 characters, never starting with '-'. It reaches the agent CLI as its own argument. Refused when the agent takes no model; spawnOptions.model in atc_spawn_options_get holds each agent's support, default, and examples. Omit it to keep the agent's configured default.",
                  "type": "string",
                },
                "name": {
                  "default": "",
                  "description": "Session name; defaults to the directory basename",
                  "type": "string",
                },
                "prompt": {
                  "default": "",
                  "description": "First message for the session",
                  "type": "string",
                },
                "scope": {
                  "additionalProperties": false,
                  "description": "Worktrees, branches, and pull requests the session may touch beyond its own workspace. atc checks each entry on the session's host, refuses an invalid or unknown entry with scope_invalid naming it, and records the rest in the session's record, which the session reads at $ATC_SESSION_RECORD.",
                  "properties": {
                    "branches": {
                      "description": "Branches that exist in repo, an absolute repository path on the session host; repo defaults to the session's directory",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "name": {
                            "type": "string",
                          },
                          "repo": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "name",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                    "pullRequests": {
                      "description": "GitHub pull requests of repo, as owner/name; repo defaults to the GitHub repository of the workspace's origin",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "number": {
                            "maximum": 9007199254740991,
                            "minimum": -9007199254740991,
                            "type": "integer",
                          },
                          "repo": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "number",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                    "worktrees": {
                      "description": "Absolute paths of git worktrees on the session host, each its worktree top level",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "path": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "path",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                  },
                  "type": "object",
                },
                "target": {
                  "description": "Execution target for the new session, one of the target ids in atc_spawn_options_get. Omit it to run on the default target (spawnDefaults.target). An unknown or unavailable target is refused; atc never runs the session on another target instead.",
                  "minLength": 1,
                  "type": "string",
                },
                "trustClonedWorkspace": {
                  "description": "Trust the exact verified clone for this launch. An explicit true or false overrides the configured target trustClonedWorkspace default; omitting both keeps trust off. Requires a workspace source and either stock Claude on the local target, which adds trust for the clone root alone to the user's Claude config, or, on an imp target, a brokered Claude gateway or stock Claude signed in through the broker, each with isolated guest config; other launches are refused. Accepts repository configuration and helpers without changing tool permission mode. Existing guest config is preserved.",
                  "type": "boolean",
                },
                "workspace": {
                  "description": "Where the session's working directory comes from. Omit it to run the session in cwd as it stands. With it, atc materializes a clean checkout into cwd on the target, which must not exist yet, or for a git source without cwd into a directory atc picks: {kind:'path', path, allowDirty?} checks out the pushed HEAD of a git checkout on the atc host, leaving its uncommitted and untracked changes behind with a warning, or refusing them when allowDirty is 'refuse'; {kind:'git', url, ref or sha, credentialRef?} checks out a branch, tag, or full commit of a repository, with credentialRef {kind:'env', name} naming the atc daemon's environment variable that holds its token. A directory outside git runs in place only on a target on the atc host itself (provider local-pty), with cwd equal to its path. Submodules and Git LFS are refused, and so is a URL that carries a credential.",
                  "oneOf": [
                    {
                      "additionalProperties": false,
                      "properties": {
                        "allowDirty": {
                          "enum": [
                            "refuse",
                            "warn",
                          ],
                          "type": "string",
                        },
                        "kind": {
                          "const": "path",
                          "type": "string",
                        },
                        "path": {
                          "format": "starts_with",
                          "pattern": "^\\/.*",
                          "type": "string",
                        },
                      },
                      "required": [
                        "kind",
                        "path",
                      ],
                      "type": "object",
                    },
                    {
                      "additionalProperties": false,
                      "properties": {
                        "credentialRef": {
                          "additionalProperties": false,
                          "properties": {
                            "kind": {
                              "const": "env",
                              "type": "string",
                            },
                            "name": {
                              "pattern": "^[A-Za-z_]\\w*$",
                              "type": "string",
                            },
                          },
                          "required": [
                            "kind",
                            "name",
                          ],
                          "type": "object",
                        },
                        "kind": {
                          "const": "git",
                          "type": "string",
                        },
                        "ref": {
                          "minLength": 1,
                          "type": "string",
                        },
                        "sha": {
                          "pattern": "^(?:[\\da-f]{40}|[\\da-f]{64})$",
                          "type": "string",
                        },
                        "url": {
                          "minLength": 1,
                          "type": "string",
                        },
                      },
                      "required": [
                        "kind",
                        "url",
                      ],
                      "type": "object",
                    },
                  ],
                },
              },
              "type": "object",
            },
            "name": "atc_session_spawn",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Type a line into a session's terminal and press Enter, as a person at the keyboard would. This tool cannot answer a menu: on a permission prompt, the folder-trust dialog or any other choice list, the text is dropped and Enter picks the highlighted option. A person answers those in the TUI. It is refused with permission_pending while the agent waits on a permission prompt. Use it for a plain-text prompt, or for an agent that takes no messages. When the agent takes messages (capabilities.message true in atc_spawn_options_get), use atc_message_send instead: it is tracked and returns the answer. Returns { written: true } once the line reaches the terminal; that does not show the agent took it, so check with atc_terminal_read or atc_events_read. A long line arrives as a paste, so the agent's input box and atc_terminal_read can show a placeholder such as [Pasted text #1] instead of the text.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
                "text": {
                  "description": "The line to type; atc presses Enter after it",
                  "type": "string",
                },
              },
              "required": [
                "session",
                "text",
              ],
              "type": "object",
            },
            "name": "atc_terminal_type",
            "outputSchema": {
              "properties": {
                "written": {
                  "type": "boolean",
                },
              },
              "required": [
                "written",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read a session's terminal screen as plain text, as it is now. Use it to see a prompt, a menu or an error the agent printed. A stopped session keeps its last screen until it is forgotten; after a daemon restart, or for a headless session, there is no screen and the call returns session_dead.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_terminal_read",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Add worktrees, branches or pull requests to the scope a session's record holds. atc checks each entry on the session's host and refuses an invalid one with scope_invalid. Entries already held change nothing, and nothing is ever removed. A session cannot add to its own scope or its parent's. Returns the record as it stands after.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "scope": {
                  "additionalProperties": false,
                  "description": "Worktrees, branches, and pull requests the session may touch beyond its own workspace. atc checks each entry on the session's host, refuses an invalid or unknown entry with scope_invalid naming it, and records the rest in the session's record, which the session reads at $ATC_SESSION_RECORD.",
                  "properties": {
                    "branches": {
                      "description": "Branches that exist in repo, an absolute repository path on the session host; repo defaults to the session's directory",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "name": {
                            "type": "string",
                          },
                          "repo": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "name",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                    "pullRequests": {
                      "description": "GitHub pull requests of repo, as owner/name; repo defaults to the GitHub repository of the workspace's origin",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "number": {
                            "maximum": 9007199254740991,
                            "minimum": -9007199254740991,
                            "type": "integer",
                          },
                          "repo": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "number",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                    "worktrees": {
                      "description": "Absolute paths of git worktrees on the session host, each its worktree top level",
                      "items": {
                        "additionalProperties": false,
                        "properties": {
                          "path": {
                            "type": "string",
                          },
                        },
                        "required": [
                          "path",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                  },
                  "type": "object",
                },
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
                "scope",
              ],
              "type": "object",
            },
            "name": "atc_session_scope_add",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Rename or pin a session. A name set here replaces auto-summaries, but a name the agent set with /rename wins: the rename is skipped and the call still returns updated. A pinned session leads every list and cannot be forgotten. A sub-session pins with its parent, so pin the parent.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "name": {
                  "description": "New display name; omit to keep",
                  "type": "string",
                },
                "pinned": {
                  "description": "Pin or unpin; omit to keep",
                  "type": "boolean",
                },
                "session": {
                  "description": "The atc session id",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_update",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Stop a session's agent process. Its live sub-sessions stop with it. On an imp the host is suspended, not destroyed, and the call fails with host_leased while something keeps the host awake. The session stays in the list as exited; atc_session_forget removes it. Stopping an exited session changes nothing.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_stop",
            "outputSchema": {
              "properties": {
                "stopped": {
                  "description": "true when the call stopped a live process; false when the session had already exited",
                  "type": "boolean",
                },
              },
              "required": [
                "stopped",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Remove a session from the list for good. On an imp target this destroys the host and everything on it, so it takes two calls: the first changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token, returns { forgotten: true, destroyed: true }. A sub-session that shares its parent's imp host needs the token too but keeps the host (destroyed: false). On any other target one call returns { forgotten: true, destroyed: false }. Refused: a live session unless stop is true, and a pinned session or a sub-session of one (unpin it with atc_session_update first). Live sub-sessions on a host that survives move to the top level.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "confirmToken": {
                  "description": "The token an earlier call on the same session returned",
                  "minLength": 1,
                  "type": "string",
                },
                "session": {
                  "description": "The atc session id",
                  "type": "string",
                },
                "stop": {
                  "description": "Stop the session when it is live; omit or false refuses a live session",
                  "type": "boolean",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_forget",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Clear a session's unread flag. Nothing else changes.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_mark_read",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List the directories earlier spawns used, newest first, as candidates for atc_session_spawn's cwd. Under the gateway, daemon picks whose history to read.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_recent_dirs_list",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read what atc_session_spawn accepts on this daemon: each agent (pass its id as agent) with whether it is installed, its capabilities, and the model and effort values it takes; each execution target (pass its id as target) with whether it is available; and spawnDefaults. A spawn that would fail says so in advance: an agent with installed false, a target with available false, or an entry in targetErrors, with their meanings in the output schema. Under the gateway it returns one such object per daemon. It never holds credentials, environment values or endpoints.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_spawn_options_get",
            "outputSchema": {
              "properties": {
                "agents": {
                  "description": "the registered agents",
                  "items": {
                    "properties": {
                      "brokerAuth": {
                        "description": "whether a session can sign in through a credential broker",
                        "type": "boolean",
                      },
                      "brokerRequired": {
                        "description": "whether the agent runs only through a credential broker",
                        "type": "boolean",
                      },
                      "capabilities": {
                        "description": "what atc can do with the agent",
                        "properties": {
                          "attach": {
                            "description": "a person can attach to its terminal",
                            "type": "boolean",
                          },
                          "input": {
                            "description": "atc_terminal_type can type into its terminal",
                            "type": "boolean",
                          },
                          "message": {
                            "description": "the agent takes messages through atc_message_send",
                            "type": "boolean",
                          },
                          "readTranscript": {
                            "description": "atc_transcript_read can read the agent's conversation log",
                            "type": "boolean",
                          },
                          "screen": {
                            "description": "atc_terminal_read can read its screen",
                            "type": "boolean",
                          },
                          "spawn": {
                            "description": "atc can start a session of the agent",
                            "type": "boolean",
                          },
                        },
                        "required": [
                          "spawn",
                          "readTranscript",
                          "message",
                          "attach",
                          "screen",
                          "input",
                        ],
                        "type": "object",
                      },
                      "id": {
                        "description": "the agent's id; pass it as agent to atc_session_spawn",
                        "type": "string",
                      },
                      "installed": {
                        "description": "whether its binary resolves on this host; a registered agent that is not installed cannot spawn",
                        "type": "boolean",
                      },
                      "kind": {
                        "description": "the agent CLI family it runs",
                        "type": "string",
                      },
                      "label": {
                        "description": "the agent's display name",
                        "type": "string",
                      },
                      "models": {
                        "additionalProperties": {
                          "type": "string",
                        },
                        "description": "the model names the config sets for the agent; null when it sets none",
                        "type": [
                          "object",
                          "null",
                        ],
                      },
                      "spawnOptions": {
                        "description": "the model and effort options a spawn takes, present when the daemon supports them",
                        "properties": {
                          "effort": {
                            "properties": {
                              "available": {
                                "description": "whether a spawn on this host can pass the option now",
                                "type": "boolean",
                              },
                              "backendEffect": {
                                "description": "applied, or unverified when the backend may ignore the option",
                                "enum": [
                                  "applied",
                                  "unverified",
                                  null,
                                ],
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "default": {
                                "description": "the configured value; null for the CLI's own default",
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "examples": {
                                "description": "example values, each with the provider model it resolves to",
                                "items": {
                                  "properties": {
                                    "resolvesTo": {
                                      "description": "the provider model the value resolves to; null when the config maps none",
                                      "type": [
                                        "string",
                                        "null",
                                      ],
                                    },
                                    "value": {
                                      "description": "a value the option takes",
                                      "type": "string",
                                    },
                                  },
                                  "required": [
                                    "value",
                                    "resolvesTo",
                                  ],
                                  "type": "object",
                                },
                                "type": "array",
                              },
                              "note": {
                                "description": "a note on the option, or null",
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "supported": {
                                "description": "whether atc passes this option to the agent CLI",
                                "type": "boolean",
                              },
                              "values": {
                                "description": "the accepted set; null for any alias or model name",
                                "items": {
                                  "type": "string",
                                },
                                "type": [
                                  "array",
                                  "null",
                                ],
                              },
                            },
                            "required": [
                              "supported",
                              "available",
                              "values",
                              "examples",
                              "default",
                              "backendEffect",
                              "note",
                            ],
                            "type": "object",
                          },
                          "model": {
                            "properties": {
                              "available": {
                                "description": "whether a spawn on this host can pass the option now",
                                "type": "boolean",
                              },
                              "backendEffect": {
                                "description": "applied, or unverified when the backend may ignore the option",
                                "enum": [
                                  "applied",
                                  "unverified",
                                  null,
                                ],
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "default": {
                                "description": "the configured value; null for the CLI's own default",
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "examples": {
                                "description": "example values, each with the provider model it resolves to",
                                "items": {
                                  "properties": {
                                    "resolvesTo": {
                                      "description": "the provider model the value resolves to; null when the config maps none",
                                      "type": [
                                        "string",
                                        "null",
                                      ],
                                    },
                                    "value": {
                                      "description": "a value the option takes",
                                      "type": "string",
                                    },
                                  },
                                  "required": [
                                    "value",
                                    "resolvesTo",
                                  ],
                                  "type": "object",
                                },
                                "type": "array",
                              },
                              "note": {
                                "description": "a note on the option, or null",
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "supported": {
                                "description": "whether atc passes this option to the agent CLI",
                                "type": "boolean",
                              },
                              "values": {
                                "description": "the accepted set; null for any alias or model name",
                                "items": {
                                  "type": "string",
                                },
                                "type": [
                                  "array",
                                  "null",
                                ],
                              },
                            },
                            "required": [
                              "supported",
                              "available",
                              "values",
                              "examples",
                              "default",
                              "backendEffect",
                              "note",
                            ],
                            "type": "object",
                          },
                        },
                        "required": [
                          "model",
                          "effort",
                        ],
                        "type": "object",
                      },
                    },
                    "required": [
                      "id",
                      "label",
                      "kind",
                      "installed",
                      "capabilities",
                      "models",
                      "spawnOptions",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "configRevision": {
                  "description": "a digest that changes whenever the target config does",
                  "type": "string",
                },
                "daemon": {
                  "description": "the host the daemon runs on",
                  "properties": {
                    "arch": {
                      "description": "the host's CPU architecture",
                      "type": "string",
                    },
                    "build": {
                      "description": "the daemon's build",
                      "type": "string",
                    },
                    "hostname": {
                      "description": "the host's name",
                      "type": "string",
                    },
                    "platform": {
                      "description": "the host's operating system",
                      "type": "string",
                    },
                  },
                  "required": [
                    "hostname",
                    "platform",
                    "arch",
                    "build",
                  ],
                  "type": "object",
                },
                "sources": {
                  "description": "the sources the TUI's spawn picker offers for choosing a directory or repository",
                  "items": {
                    "properties": {
                      "id": {
                        "description": "the source's id",
                        "type": "string",
                      },
                      "kind": {
                        "description": "path for a directory on the host, git for a repository URL",
                        "type": "string",
                      },
                      "label": {
                        "description": "the source's display name",
                        "type": "string",
                      },
                    },
                    "required": [
                      "id",
                      "label",
                      "kind",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "spawnDefaults": {
                  "description": "what a spawn without agent or target runs with",
                  "properties": {
                    "agent": {
                      "description": "the agent id a spawn without agent runs",
                      "type": "string",
                    },
                    "target": {
                      "description": "the target id a spawn without target runs on; a null target means a spawn without target is refused",
                      "type": [
                        "string",
                        "null",
                      ],
                    },
                  },
                  "required": [
                    "agent",
                    "target",
                  ],
                  "type": "object",
                },
                "targetErrors": {
                  "description": "config problems that leave a target, or every target, unusable; scope config, with problem config_malformed or config_unreadable, means the config file exists but cannot be parsed or read, and refuses every spawn, local included",
                  "items": {
                    "properties": {
                      "detail": {
                        "description": "the problem in words",
                        "type": "string",
                      },
                      "path": {
                        "description": "the config path the problem is about",
                        "type": "string",
                      },
                      "problem": {
                        "description": "the problem code, such as config_malformed",
                        "type": "string",
                      },
                      "scope": {
                        "description": "what the problem affects",
                        "enum": [
                          "config",
                          "targets",
                          "target",
                          "defaultTarget",
                        ],
                        "type": "string",
                      },
                      "target": {
                        "description": "the target the problem is about, when one",
                        "type": "string",
                      },
                    },
                    "required": [
                      "scope",
                      "problem",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "targets": {
                  "description": "the execution targets, present when the daemon supports targets",
                  "items": {
                    "properties": {
                      "available": {
                        "description": "whether a spawn can use the target now",
                        "type": "boolean",
                      },
                      "brokerAuth": {
                        "description": "whether sessions on the target sign in through a credential broker",
                        "type": "boolean",
                      },
                      "capabilities": {
                        "additionalProperties": {
                          "type": "boolean",
                        },
                        "description": "what the target can do, by capability name",
                        "type": "object",
                      },
                      "default": {
                        "description": "whether a spawn without target runs here",
                        "type": "boolean",
                      },
                      "id": {
                        "description": "the target's id; pass it as target to atc_session_spawn",
                        "type": "string",
                      },
                      "identity": {
                        "description": "the target's identity",
                        "type": "string",
                      },
                      "provider": {
                        "description": "the target's provider kind",
                        "type": "string",
                      },
                    },
                    "required": [
                      "id",
                      "provider",
                      "identity",
                      "available",
                      "default",
                      "capabilities",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
              },
              "required": [
                "daemon",
                "agents",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read one session: its entry as atc_sessions_list shows it, the prompt it was spawned with, when it last reported activity, pending (the agent's notification text while it is needs_you, such as "Claude needs your permission"; never a menu's options), result (the final reply of its latest finished turn) and sessionRecord (the scope atc recorded for it). A permission prompt or other menu cannot be answered through atc; a person answers it in the TUI.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_get",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read a session's conversation log a page at a time, oldest first: user and assistant messages, with tool uses summarised. Pass the returned cursor to continue; more is true when the page stopped before the end. Claude and Claude-compatible agents only; other agents return unsupported.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "cursor": {
                  "description": "The cursor a previous atc_transcript_read returned; omit to read from the start of the conversation",
                  "type": "string",
                },
                "limit": {
                  "description": "Most rows to return; defaults to 50",
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_transcript_read",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read the fleet's event feed: the one call to catch up on session state changes, the notes sessions send, and the progress of messages you sent, oldest first. It holds session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-queued, message-delivered, message-answered, with the message id) and notes (note, with its label and full text). Pass the returned cursor on the next call; more true means the page stopped early, so read again at once. Without a cursor it returns the latest events, and more is false even when older ones exist. waitMs holds the call until an event arrives, up to 30000; use it instead of polling. session limits the read to one session; previewOnly true returns 600-character note previews. A partial read says so: complete false or textError on a note, and, under the gateway, unavailable, started or truncated, with their meanings in the output schema.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "cursor": {
                  "description": "The cursor a previous atc_events_read returned; omit to get the most recent events",
                  "type": "string",
                },
                "limit": {
                  "description": "Most events to return; defaults to 50",
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
                "previewOnly": {
                  "description": "true returns each note as its 600-character preview instead of its full text; defaults to false",
                  "type": "boolean",
                },
                "session": {
                  "description": "An atc session id; limits the read to that session's events. Cursors stay valid across filtered and unfiltered reads",
                  "type": "string",
                },
                "waitMs": {
                  "description": "How long to wait for a new event when none is pending, in milliseconds; defaults to 0, capped at 30000. Keep it short.",
                  "maximum": 30000,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "type": "object",
            },
            "name": "atc_events_read",
            "outputSchema": {
              "properties": {
                "cursor": {
                  "type": "string",
                },
                "events": {
                  "items": {
                    "properties": {
                      "at": {
                        "type": "number",
                      },
                      "complete": {
                        "description": "false: atc kept only this note's preview, and text holds it",
                        "type": "boolean",
                      },
                      "cursor": {
                        "type": "string",
                      },
                      "detail": {
                        "type": [
                          "string",
                          "null",
                        ],
                      },
                      "kind": {
                        "description": "the event kind; the tool description lists them",
                        "type": "string",
                      },
                      "label": {
                        "type": "string",
                      },
                      "message": {
                        "type": "string",
                      },
                      "name": {
                        "type": [
                          "string",
                          "null",
                        ],
                      },
                      "session": {
                        "type": "string",
                      },
                      "text": {
                        "type": "string",
                      },
                      "textError": {
                        "description": "the note's text did not load within 10 seconds; detail holds the preview",
                        "type": "string",
                      },
                    },
                    "required": [
                      "cursor",
                      "at",
                      "session",
                      "name",
                      "kind",
                      "detail",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "more": {
                  "type": "boolean",
                },
                "started": {
                  "description": "under the gateway, daemons that joined the cursor on this call, read from their latest events",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "truncated": {
                  "description": "under the gateway, those of the started daemons with older events left unread",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "unavailable": {
                  "description": "under the gateway, daemons that did not answer; each keeps its place in the cursor",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
              },
              "required": [
                "events",
                "cursor",
                "more",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Send a message to a session's agent and get its id back. The message goes into the agent's conversation, never into the terminal, and the agent's answer comes back on the message: follow with atc_message_get and waitMs until status is answered. status is queued (waiting in atc's inbox), delivered (handed to the session, not yet confirmed as seen by the model) or answered. The answer is the final reply of the turn that carried the message; messages in one turn share it, and answeredWith lists them. A message whose turn is interrupted stays delivered. Refused: unsupported when the agent takes no messages (capabilities.message false in atc_spawn_options_get) or its message bridge never attached; session_dead when the session has no live process, including one still booting after a daemon restart; no_such_session for an unknown id. A retry with the same idempotencyKey and text returns the same message.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "from": {
                  "description": "Who the message is from; defaults to the calling session id, or mcp outside a session. Ignored for a remote client, whose messages are always from its own name",
                  "type": "string",
                },
                "idempotencyKey": {
                  "description": "A key, unique to this call, that makes a retry safe: retrying with the same key and arguments returns the first answer instead of acting again, and the same key with different arguments is refused as idempotency_conflict. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters",
                  "maxLength": 180,
                  "minLength": 1,
                  "type": "string",
                },
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
                "text": {
                  "description": "The message text",
                  "type": "string",
                },
              },
              "required": [
                "session",
                "text",
              ],
              "type": "object",
            },
            "name": "atc_message_send",
            "outputSchema": {
              "properties": {
                "message": {
                  "type": "string",
                },
                "status": {
                  "enum": [
                    "queued",
                    "delivered",
                    "answered",
                  ],
                  "type": "string",
                },
              },
              "required": [
                "message",
                "status",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read one message sent with atc_message_send: status (queued, delivered or answered), the answer once answered, turn, answeredWith and timestamps. The answer is the final reply of the turn that carried the message; messages in one turn share it, and answeredWith lists them. Pass waitMs, up to 30000, to hold the call until the status changes; an answered message returns at once. Ids and statuses persist, so call again after a timeout.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "message": {
                  "description": "The message id atc_message_send returned",
                  "type": "string",
                },
                "waitMs": {
                  "description": "How long to hold the call until the message status changes from what it was when you called, in milliseconds; defaults to 0, capped at 30000",
                  "maximum": 30000,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "message",
              ],
              "type": "object",
            },
            "name": "atc_message_get",
            "outputSchema": {
              "properties": {
                "answer": {
                  "type": "string",
                },
                "answeredAt": {
                  "type": "number",
                },
                "answeredWith": {
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "deliveredAt": {
                  "type": "number",
                },
                "from": {
                  "type": "string",
                },
                "message": {
                  "type": "string",
                },
                "sentAt": {
                  "type": "number",
                },
                "session": {
                  "type": "string",
                },
                "status": {
                  "enum": [
                    "queued",
                    "delivered",
                    "answered",
                  ],
                  "type": "string",
                },
                "text": {
                  "type": "string",
                },
                "turn": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
              },
              "required": [
                "message",
                "session",
                "from",
                "text",
                "status",
                "turn",
                "answeredWith",
                "sentAt",
              ],
              "type": "object",
            },
          },
        ],
      },
    }
  `);
});

test('it lists every tool with its three safety hints', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('tools/list');

  expect(response).toStrictEqual({
    jsonrpc: '2.0',
    id: 2,
    result: {
      tools: [
        expect.objectContaining({
          name: 'atc_sessions_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_spawn',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_terminal_type',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_terminal_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_scope_add',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_update',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_stop',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_forget',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_mark_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_recent_dirs_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_spawn_options_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_transcript_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_events_read',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_message_send',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_message_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
      ],
    },
  });
});

test('it marks the kill tool destructive and not read-only', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const response = await mcp.sendRequest('tools/list');

  const result = response['result'];

  invariant(isRecord(result) && Array.isArray(result['tools']), 'tools/list returned no tools');

  const killTool: unknown = result['tools'].find(
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_stop',
  );

  invariant(isRecord(killTool), 'the kill tool is not listed');

  expect(killTool['annotations']).toStrictEqual({
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });
});

test('it keeps answering after a failed tool call', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: ctx.claudeBin,
      claudeArgs: [],
      grokBin: ctx.grokBin,
      grokArgs: [],

      // A codex binary on the host would change the served tool descriptions.
      codexBin: '/nonexistent/codex',
    }),
  );

  const mcp = await startMCPStdio({ home: ctx.home });
  const failed = await mcp.sendToolCall('atc_session_stop', { session: 'nope' });

  expect(failed).toStrictEqual({
    isError: true,
    text: expect.toInclude('no_such_session'),
    structured: undefined,
  });

  const pong = await mcp.sendRequest('ping');

  expect(pong).toStrictEqual({ jsonrpc: '2.0', id: 3, result: {} });
});
