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
            "description": "List every session the atc daemon hosts: id, name, working directory, state (running, needs_you, done, exited), unread flag, and last activity.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_session_list",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Spawn a new session in a directory. Optional agent is a registered agent id; omitted agent is the host's default agent (claude when it is registered, else the first registered agent), never the TUI last-used value. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_agents_list returns the current agents, whether each is installed, and the model and effort each takes. An unregistered agent, a registered agent that is not installed, and a model or effort the agent does not take are refused before anything spawns. Called from inside an atc session, the new session is a sub-session of the caller unless detached is true. Returns the new session descriptor. Give it a prompt to start it working immediately.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "agent": {
                  "description": "Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_agents_list returns the current list.",
                  "minLength": 1,
                  "type": "string",
                },
                "cwd": {
                  "description": "Absolute path of the working directory. Required, except with a git workspace: omit it there and atc picks a new directory under the target user's home, ~/.local/share/atc/workspaces/<repo>-<ref>-<short sha> unless the config sets another root, adding -2, -3, and so on when that directory exists. The session's cwd in the result holds the path it landed in.",
                  "minLength": 1,
                  "type": "string",
                },
                "detached": {
                  "description": "Spawn a top-level session. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, killed with it.",
                  "type": "boolean",
                },
                "effort": {
                  "description": "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_agents_list. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
                  "type": "string",
                },
                "idempotencyKey": {
                  "description": "A key, unique to this call, that makes a retry safe: retrying with the same key and arguments returns the first answer instead of acting again, and the same key with different arguments is refused as idempotency_conflict. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters",
                  "maxLength": 180,
                  "minLength": 1,
                  "type": "string",
                },
                "model": {
                  "description": "Model for the new session: an alias or a full model name, at most 200 characters, never starting with '-'. It reaches the agent CLI as its own argument. Refused when the agent takes no model; spawnOptions.model in atc_agents_list holds each agent's support, default, and examples. Omit it to keep the agent's configured default.",
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
                "target": {
                  "description": "Execution target for the new session, one of the target ids in atc_agents_list. Omit it to run on the default target (spawnDefaults.target). An unknown or unavailable target is refused; atc never runs the session on another target instead.",
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
            "description": "Type a line of text into a running session and submit it, as if the operator typed it and pressed enter. atc submits the line the way the session's agent accepts one. Use it to answer a session that is waiting on input. atc pastes the line, so its newlines stay in it, and Claude takes a line of about 800 characters or more as pasted text, not as typed words. A line that starts with a slash command and an argument, such as /goal finish the release, has the command name typed and only the argument pasted, so the command runs at any length. A result of sent means atc wrote the line and its submit key to the session; it does not confirm that the agent took the line or answered it. Read the session's screen or events for that. The tool sends no raw keystrokes.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id",
                  "type": "string",
                },
                "text": {
                  "description": "The line to submit; atc adds the submit key the session's agent expects",
                  "type": "string",
                },
              },
              "required": [
                "session",
                "text",
              ],
              "type": "object",
            },
            "name": "atc_session_input",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read the current terminal screen of a session as plain text, without attaching to it. Use it to see what a session printed or what it is waiting on before answering it with atc_session_input. A killed session keeps its last screen.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_session_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_screen",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Rename and/or pin a session. Renames stick against auto-summaries; pinned sessions lead every list. A sub-session pins with its parent, so pin the parent instead. Use this to organise the fleet: name sessions after their task.",
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
            "description": "Kill a session. A second kill on a dead session removes it from the list.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_session_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_kill",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Forget a session for good: it leaves the list. A live local sub-session of the session is not stopped: it stays alive and moves to the top level. On a target that can destroy its host (an imp), the first call changes nothing and returns { confirmToken, expiresAt }, a token good for 60 seconds; a second call with that token destroys the host and returns { forgotten: true, destroyed: true }, except that a sub-session on the imp host of its parent does not destroy that host and returns destroyed: false. On any other target one call forgets and returns { forgotten: true, destroyed: false }. A live session is refused unless stop is true, which stops it as part of the forget. A pinned session, or a sub-session of a pinned session, is refused: unpin it with atc_session_update first.",
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
            "description": "Clear a session unread flag without attaching to it.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_session_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_ack",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Build the shell command that reopens a session outside atc (cd into its directory and claude --resume its id).",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_session_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_resume_command",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List directories sessions were previously spawned from, most recent first.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_dirs_list",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List the agents this atc host can run sessions under, plus the host itself (daemon: hostname, platform, arch, build). Each agent has its id (pass it as atc_session_spawn's agent), label, kind (the agent CLI family it runs), installed (whether its binary resolves on this host; a registered agent that is not installed cannot spawn), capabilities (spawn, readTranscript, message, attach, screen, input), models (the model names the config sets for it, or null), and spawnOptions when the daemon supports spawn options. spawnOptions holds model and effort, each with supported (whether atc passes it to the agent CLI), available (whether a spawn on this host can pass it now), values (the accepted set, or null for any alias or model name), examples (each with the provider model it resolves to, when the config maps one), default (the configured value, or null for the CLI's own), backendEffect (applied, or unverified when the backend may ignore it), and a note. atc_session_spawn accepts exactly the available options. When the daemon supports targets, it also returns targets (each with its id, provider kind, identity, available, default, and capabilities), spawnDefaults (the agent and target a spawn without either runs with; a null target means such a spawn is refused), configRevision (a digest that changes whenever the target config does), and targetErrors (config problems that leave a target, or every target, unusable; a config file that exists but cannot be read or parsed is scope config, problem config_malformed or config_unreadable, with its path and detail, and refuses every spawn, local included). It never includes credentials, environment values, or endpoints, and holds nothing about which plans or subscriptions an agent's account has.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_agents_list",
            "outputSchema": {
              "properties": {
                "agents": {
                  "items": {
                    "properties": {
                      "brokerAuth": {
                        "type": "boolean",
                      },
                      "brokerRequired": {
                        "type": "boolean",
                      },
                      "capabilities": {
                        "properties": {
                          "attach": {
                            "type": "boolean",
                          },
                          "input": {
                            "type": "boolean",
                          },
                          "message": {
                            "type": "boolean",
                          },
                          "readTranscript": {
                            "type": "boolean",
                          },
                          "screen": {
                            "type": "boolean",
                          },
                          "spawn": {
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
                        "type": "string",
                      },
                      "installed": {
                        "type": "boolean",
                      },
                      "kind": {
                        "type": "string",
                      },
                      "label": {
                        "type": "string",
                      },
                      "models": {
                        "additionalProperties": {
                          "type": "string",
                        },
                        "type": [
                          "object",
                          "null",
                        ],
                      },
                      "spawnOptions": {
                        "properties": {
                          "effort": {
                            "properties": {
                              "available": {
                                "type": "boolean",
                              },
                              "backendEffect": {
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
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "examples": {
                                "items": {
                                  "properties": {
                                    "resolvesTo": {
                                      "type": [
                                        "string",
                                        "null",
                                      ],
                                    },
                                    "value": {
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
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "supported": {
                                "type": "boolean",
                              },
                              "values": {
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
                                "type": "boolean",
                              },
                              "backendEffect": {
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
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "examples": {
                                "items": {
                                  "properties": {
                                    "resolvesTo": {
                                      "type": [
                                        "string",
                                        "null",
                                      ],
                                    },
                                    "value": {
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
                                "type": [
                                  "string",
                                  "null",
                                ],
                              },
                              "supported": {
                                "type": "boolean",
                              },
                              "values": {
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
                  "type": "string",
                },
                "daemon": {
                  "properties": {
                    "arch": {
                      "type": "string",
                    },
                    "build": {
                      "type": "string",
                    },
                    "hostname": {
                      "type": "string",
                    },
                    "platform": {
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
                "spawnDefaults": {
                  "properties": {
                    "agent": {
                      "type": "string",
                    },
                    "target": {
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
                  "items": {
                    "properties": {
                      "detail": {
                        "type": "string",
                      },
                      "path": {
                        "type": "string",
                      },
                      "problem": {
                        "type": "string",
                      },
                      "scope": {
                        "enum": [
                          "config",
                          "targets",
                          "target",
                          "defaultTarget",
                        ],
                        "type": "string",
                      },
                      "target": {
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
                  "items": {
                    "properties": {
                      "available": {
                        "type": "boolean",
                      },
                      "brokerAuth": {
                        "type": "boolean",
                      },
                      "capabilities": {
                        "additionalProperties": {
                          "type": "boolean",
                        },
                        "type": "object",
                      },
                      "default": {
                        "type": "boolean",
                      },
                      "id": {
                        "type": "string",
                      },
                      "identity": {
                        "type": "string",
                      },
                      "provider": {
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
            "description": "Read one session in a single call: its descriptor (state, unread flag, last activity message), the prompt it was spawned with, when it last reported activity, the prompt or question it is waiting on while it needs you (read-only; answer it with atc_session_input), and the final message of its latest finished turn.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_session_list",
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
            "description": "Read a session's conversation a page at a time, oldest first: user and assistant messages with tool uses summarised. Pass the returned cursor to continue where you left off; more is true when the page stopped before the end. Claude sessions only; other agents answer unsupported.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "cursor": {
                  "description": "The cursor a previous atc_session_read returned; omit to read from the start of the conversation",
                  "type": "string",
                },
                "limit": {
                  "description": "Most rows to return; defaults to 50",
                  "maximum": 200,
                  "minimum": 1,
                  "type": "integer",
                },
                "session": {
                  "description": "The atc session id, from atc_session_list",
                  "type": "string",
                },
              },
              "required": [
                "session",
              ],
              "type": "object",
            },
            "name": "atc_session_read",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Catch up on the fleet: session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-accepted, message-delivered, message-answered), and reports (report) since a cursor, oldest first, each with the session id and name. A message event carries the message id; read the full message with atc_message_get. A report event carries its label and a preview of its text; read the full text with atc_report_get, passing the report handle of that event when it carries one, else its cursor, or pass reportText: true to get the full text of every report in this call. With reportText, each report event also carries text and complete (false when atc kept only the preview), or textError when its text could not be read within 10 seconds; the page holds at most 64 KiB of report text and stops early, with more true, when the next report would not fit or 10 seconds of report reads have passed. Without a cursor it returns the most recent events. Pass the returned cursor next time; more is true when the page stopped before the newest event, so read again at once. session limits the read to one session. waitMs holds the call open until an event arrives; pass it instead of polling in a tight loop.",
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
                "reportText": {
                  "description": "true adds each report's whole text to its event, so one call reads every report of the page; defaults to false",
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
                      "report": {
                        "type": "string",
                      },
                      "session": {
                        "type": "string",
                      },
                      "text": {
                        "type": "string",
                      },
                      "textError": {
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
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read one report's full text without messaging the session that sent it. Pass the report handle of the report's event from atc_events_read, or the event's cursor when it carries none. Returns the report cursor, at, the session id and name, the label, the text (up to 64 KiB, as the session sent it), and complete, which is false for a report recorded before atc kept full texts: its text is then only the preview the event held. A cursor of an event that is not a report answers as an unknown report.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "report": {
                  "description": "The report handle of the report's event from atc_events_read, or the event's cursor when it carries no report handle",
                  "type": "string",
                },
              },
              "required": [
                "report",
              ],
              "type": "object",
            },
            "name": "atc_report_get",
            "outputSchema": {
              "properties": {
                "at": {
                  "type": "number",
                },
                "complete": {
                  "type": "boolean",
                },
                "label": {
                  "type": "string",
                },
                "name": {
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "report": {
                  "type": "string",
                },
                "session": {
                  "type": "string",
                },
                "text": {
                  "type": "string",
                },
              },
              "required": [
                "report",
                "at",
                "session",
                "name",
                "label",
                "text",
                "complete",
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
            "description": "Send a session a message and get its id back. Follow up with atc_message_get, passing waitMs so each call waits for the next status change instead of polling in a tight loop, until its status is answered; don't read the session's screen or transcript to check on it. The answer is the final output of the session turn that carried the message, and one turn can carry several messages. The message waits in the session inbox until the session takes it, and its status moves accepted, delivered, answered. A message is refused as unsupported when the session's agent has no message tap (capabilities.message is false in atc_agents_list), or when a Claude session reported SessionStart more than 15 seconds ago and no tap has attached since. It is refused as session_dead when the session has no live process and as no_such_session for an unknown id. Otherwise it queues, including while a session restores or after its tap dropped. The message is never typed into the terminal.",
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
                  "description": "The atc session id, from atc_session_list",
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
            "name": "atc_session_message",
            "outputSchema": {
              "properties": {
                "message": {
                  "type": "string",
                },
                "status": {
                  "enum": [
                    "accepted",
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
            "description": "Read one message sent with atc_session_message: its id, session, from, text, status (accepted, delivered, or answered), the answer once answered, turn, answeredWith, and the sentAt, deliveredAt, and answeredAt timestamps. The answer is the final output of the session turn that carried the message, not a reply to that message alone: when one turn carries several messages, each gets the same answer. turn is that turn id, or null when the session reported none, and answeredWith lists the other messages the same turn answered. Pass waitMs to hold the call until the status changes from what it was when you called, up to 30000 ms, instead of polling in a tight loop; an answered message returns at once. Message ids and statuses persist, so after a call ends or times out, call again with the same id.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "message": {
                  "description": "The message id atc_session_message returned",
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
                    "accepted",
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
          name: 'atc_session_list',
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
          name: 'atc_session_input',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_screen',
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
          name: 'atc_session_kill',
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
          name: 'atc_session_ack',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_resume_command',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_dirs_list',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_agents_list',
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
          name: 'atc_session_read',
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
          name: 'atc_report_get',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_message',
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
    (tool) => isRecord(tool) && tool['name'] === 'atc_session_kill',
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
  const failed = await mcp.sendToolCall('atc_session_kill', { session: 'nope' });

  expect(failed).toStrictEqual({
    isError: true,
    text: expect.toInclude('no_such_session'),
    structured: undefined,
  });

  const pong = await mcp.sendRequest('ping');

  expect(pong).toStrictEqual({ jsonrpc: '2.0', id: 3, result: {} });
});
