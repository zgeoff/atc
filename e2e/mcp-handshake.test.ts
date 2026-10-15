import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { setupMCPHome } from '@atc/lifecycle/testing';
import { startMCPStdio } from '@atc/test-utils';
import invariant from 'tiny-invariant';

function setupTest() {
  const mcpHome = setupMCPHome();

  return { home: mcpHome.home, claudeBin: mcpHome.claudeBin, grokBin: mcpHome.grokBin };
}

test('it answers initialize with the requested protocol version and its server name', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
            "description": "List the sessions atc hosts, or every daemon's sessions under the gateway, with each one's id, name, directory, agent, state, unread and pinned flags, and the parent of each sub-session. For one session's pending prompt and last reply, use atc_session_get. state is running (the agent is working), needs_you (the agent asked for a person, such as a permission prompt), done (the turn ended; it waits for the next prompt) or exited (no live process: it ended, or it sleeps inside a suspended imp host). The list keeps the order atc holds the sessions in and does not put pinned sessions first. A remote client sees only the sessions whose whole tree it reaches. Under the gateway, daemons holds each daemon's state, so a daemon that is down never reads as one with no sessions.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_sessions_list",
            "outputSchema": {
              "properties": {
                "daemons": {
                  "description": "under the gateway, each daemon's state",
                  "items": {
                    "properties": {
                      "name": {
                        "description": "the daemon's name",
                        "type": "string",
                      },
                      "state": {
                        "description": "up, down, unauthorized, changed, outdated (older than this gateway) or refused (it answered with an error); a later daemon may add a value",
                        "type": "string",
                      },
                    },
                    "required": [
                      "name",
                      "state",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
                "sessions": {
                  "description": "the sessions, sub-sessions included, in the order atc holds them",
                  "items": {
                    "properties": {
                      "agent": {
                        "description": "the agent id the session runs",
                        "type": "string",
                      },
                      "alive": {
                        "description": "whether atc holds a live process for the session",
                        "type": "boolean",
                      },
                      "createdAt": {
                        "description": "when atc created the session, in epoch milliseconds",
                        "type": "number",
                      },
                      "cwd": {
                        "description": "the session's working directory on its host",
                        "type": "string",
                      },
                      "id": {
                        "description": "the atc session id; under the gateway it starts with the daemon's name",
                        "type": "string",
                      },
                      "kind": {
                        "description": "pty for a terminal session, headless for a headless one",
                        "type": "string",
                      },
                      "lastMsg": {
                        "description": "atc's one-line summary of the session's latest state",
                        "type": "string",
                      },
                      "lifecycle": {
                        "description": "the wanted and actual state of the session's host, harness and attachment",
                        "type": "object",
                      },
                      "locator": {
                        "description": "the daemon and target the session runs on",
                        "type": "object",
                      },
                      "model": {
                        "description": "the model the spawn asked for; absent when the agent's default runs",
                        "type": "string",
                      },
                      "name": {
                        "description": "the session's display name",
                        "type": "string",
                      },
                      "parent": {
                        "description": "the id of the session this one is a sub-session of; absent on a top-level session",
                        "type": "string",
                      },
                      "pinned": {
                        "description": "whether the session carries a pin of its own",
                        "type": "boolean",
                      },
                      "state": {
                        "description": "running, needs_you, done or exited; the atc_sessions_list description holds their meanings, and a later daemon may add a value",
                        "type": "string",
                      },
                      "unread": {
                        "description": "whether the session has news no one has read",
                        "type": "boolean",
                      },
                      "workspace": {
                        "description": "the repository and commit atc checked out for the session; absent without a workspace source",
                        "type": "object",
                      },
                    },
                    "required": [
                      "id",
                      "name",
                      "cwd",
                      "agent",
                      "state",
                    ],
                    "type": "object",
                  },
                  "type": "array",
                },
              },
              "required": [
                "sessions",
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
            "description": "Start a new agent session in a directory and return its entry. prompt goes to the agent CLI as its first message at launch; the result does not show that the agent took it, so follow with atc_events_read. agent defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, grok, codex (not installed). atc_spawn_options_get lists the agents, targets, models and effort levels this daemon takes. An unknown or uninstalled agent, an unknown target, an effort outside the agent's values, or a missing or relative cwd is refused before anything starts; a model name goes to the agent CLI unchecked when the agent lists no model values. A workspace or scope refusal can come after atc readied the host, and atc then rolls the spawn back. Called through atc mcp from inside an atc session, the new session is a sub-session unless detached is true: of the caller, or of the caller's parent when the caller is a sub-session itself. It is listed under that parent, pinned and stopped with it, forgettable while it is pinned only by a call from inside it, and reached by a remote client only when the client reaches it. A spawn through atc mcp --http or the gateway, or from a caller atc no longer lists, starts a top-level session. atc_session_update with parent null detaches a sub-session later. A directory the agent has not trusted opens its folder-trust dialog, which atc_terminal_choose answers for Claude Code and a person answers in the TUI for any agent; trustClonedWorkspace trusts a fresh workspace clone. The entry holds warnings when the workspace left changes behind. A retry with the same idempotencyKey and arguments starts no second session: while atc lists the session, it returns the session's current entry without the first call's warnings.",
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
                  "description": "Spawn a top-level session with no parent, whose pin and forget stand on their own. By default a spawn from inside an atc session becomes a sub-session of it: listed under it, pinned with it, stopped with it, and forgettable while it is pinned only by a call from inside it. atc_session_update with parent null detaches a sub-session later.",
                  "type": "boolean",
                },
                "effort": {
                  "description": "Effort level for the new session, one of the agent's spawnOptions.effort.values in atc_spawn_options_get. Refused when the agent takes no effort. Omit it to keep the agent's configured default.",
                  "type": "string",
                },
                "idempotencyKey": {
                  "description": "A key, unique to this call, that makes a retry safe: retrying with the same key and arguments acts only once and returns what the first call made as it stands now, and the same key with different arguments is refused as idempotency_conflict. A call refused with an error such as session_dead leaves no key on the daemon, so retry it under a new key: the same key runs the call again on a daemon reached directly, but under the gateway it returns outcome_unknown and runs nothing. atc forgets a key 24 hours after its call completed. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters",
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
                  "description": "Session name; defaults to the basename of the working directory, without the -2, -3 suffix of a directory atc picked",
                  "type": "string",
                },
                "prompt": {
                  "default": "",
                  "description": "First message for the session",
                  "type": "string",
                },
                "scope": {
                  "additionalProperties": false,
                  "description": "Worktrees, branches, and pull requests the session may touch beyond its own workspace, at most 64 of each. atc checks worktrees and branches on the session's host and pull requests with gh on the atc daemon's host. The first invalid or unknown entry refuses the whole scope with scope_invalid naming it, and atc records none of it. A valid scope goes into the session's record, which the session reads at $ATC_SESSION_RECORD.",
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
                  "description": "Trust the exact verified clone for this launch. An explicit true or false overrides the configured target trustClonedWorkspace default; omitting both keeps trust off. Requires a workspace source and either stock Claude on the local target, which adds trust for the clone root alone to the user's Claude config, or, on an imp target, an agent signed in through the broker whose isolated guest config takes trust, such as a brokered Claude gateway or stock Claude; other launches are refused, and the refusal lists the ones that work. Accepts repository configuration and helpers without changing tool permission mode. Existing guest config is preserved.",
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
            "outputSchema": {
              "properties": {
                "agent": {
                  "description": "the agent id the session runs",
                  "type": "string",
                },
                "alive": {
                  "description": "whether atc holds a live process for the session",
                  "type": "boolean",
                },
                "createdAt": {
                  "description": "when atc created the session, in epoch milliseconds",
                  "type": "number",
                },
                "cwd": {
                  "description": "the session's working directory on its host",
                  "type": "string",
                },
                "id": {
                  "description": "the atc session id; under the gateway it starts with the daemon's name",
                  "type": "string",
                },
                "kind": {
                  "description": "pty for a terminal session, headless for a headless one",
                  "type": "string",
                },
                "lastMsg": {
                  "description": "atc's one-line summary of the session's latest state",
                  "type": "string",
                },
                "lifecycle": {
                  "description": "the wanted and actual state of the session's host, harness and attachment",
                  "type": "object",
                },
                "locator": {
                  "description": "the daemon and target the session runs on",
                  "type": "object",
                },
                "model": {
                  "description": "the model the spawn asked for; absent when the agent's default runs",
                  "type": "string",
                },
                "name": {
                  "description": "the session's display name",
                  "type": "string",
                },
                "parent": {
                  "description": "the id of the session this one is a sub-session of; absent on a top-level session",
                  "type": "string",
                },
                "pinned": {
                  "description": "whether the session carries a pin of its own",
                  "type": "boolean",
                },
                "state": {
                  "description": "running, needs_you, done or exited; the atc_sessions_list description holds their meanings, and a later daemon may add a value",
                  "type": "string",
                },
                "unread": {
                  "description": "whether the session has news no one has read",
                  "type": "boolean",
                },
                "warnings": {
                  "description": "what the workspace left behind, such as uncommitted changes; absent when there is none, and on a retry with the same idempotencyKey",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "workspace": {
                  "description": "the repository and commit atc checked out for the session; absent without a workspace source",
                  "type": "object",
                },
              },
              "required": [
                "id",
                "name",
                "cwd",
                "agent",
                "state",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Type a line into a session's terminal and press Enter, as a person at the keyboard would. This tool cannot answer a menu: on a permission prompt, the folder-trust dialog or any other choice list, the text is dropped and Enter picks the highlighted option. atc_terminal_choose answers a Claude Code menu, and a person answers any other in the TUI. Only a Claude or Claude-compatible session refuses the line with permission_pending while a permission prompt is open; atc sees no permission prompt of any other agent, and never sees the folder-trust dialog. Use it for a plain-text prompt, or for an agent that takes no messages. When the agent takes messages (capabilities.message true in atc_spawn_options_get), use atc_message_send instead: atc tracks the message, stores the answer, and puts the outcome into a sending session's conversation as an <atc-answer> notice. Returns { written: true } once the line reaches the terminal; that does not show the agent took it, so check with atc_terminal_read or atc_events_read. On a headless session the line starts a headless turn as its prompt and returns the same result; a headless session whose turn still runs refuses it with too_slow. A session with no terminal refuses it with session_dead. The text goes in as one paste, newlines included, whenever the agent's terminal takes pastes, so the agent's input box and atc_terminal_read can show a placeholder such as [Pasted text #1] instead of the text. Empty text presses Enter alone, which submits what the input box already holds. A retry types the line again.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "session": {
                  "description": "The atc session id, from atc_sessions_list",
                  "type": "string",
                },
                "text": {
                  "description": "The line to type; atc presses Enter after it. Empty text presses Enter alone",
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
                  "description": "true once the line reached the terminal, or started a headless turn; it does not show the agent took it",
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
              "destructiveHint": true,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Read or answer the menu a session's agent waits on in its terminal, such as a permission prompt, the folder-trust dialog or the new MCP servers list. For a plain-text prompt, use atc_terminal_type. Called with session alone, it returns { menu }: the menu's text, its options with their numbers, labels, ticked boxes and cursor, and menuToken; menu is null when the screen shows no menu. A list longer than the screen, such as a long new MCP servers list, reads whole: atc waits until the agent has printed nothing, moves the cursor through the list with arrow keys, puts it back on the option it was on, and numbers every option by its place in the whole list, so a choice can pick an option the screen does not show. A menu that fits on the screen, or a list atc has read whole before, takes no key, except a list that fills Claude Code's list window with the cursor on its last row, where the screen cannot show whether more options follow; a read never presses Enter or Escape. To pick an option, call again with its option number, its label as read, and menuToken: atc checks all three against the screen before it presses a key, waits until the agent has printed nothing for 4 seconds, or 10 seconds at most, since Claude Code refuses Enter on a menu that has just opened and then moves its cursor back, moves the cursor one arrow key at a time, and presses Enter only once the cursor is on that option. Enter on an option with a box ticks or clears that box and keeps the menu open; pick the menu's own item, such as Enable selected, to confirm it. key escape with menuToken presses Escape on that menu instead: it dismisses the menu, rejects every server on the new MCP servers list, and exits the agent on the folder-trust dialog. A choice returns { pressed, menu }: the key atc pressed last and the menu the screen shows once it settles, or null. A choice whose menu atc could not read whole afterwards says so with partial true, as the output schema describes. The same menu with the cursor on the option means the agent ignored the key, or opened a new menu that reads the same; check atc_events_read before you call again with its menuToken. A refusal presses nothing that picks an option, though menu_changed and menu_busy can come after arrow keys moved the cursor: menu_changed when the screen shows another menu or none, menu_label_mismatch when the menu has no such option or its label differs, and menu_busy when the cursor did not reach the option. A read of a long list can be refused with menu_changed or menu_busy the same way, after arrow keys moved its cursor, and with menu_busy on a terminal too short to show two rows of the list. After any refusal, read the menu again for its state and menuToken. session_dead refuses a session with no screen. menuToken matches any menu with the same text, labels and boxes, so a retry after a choice that went through answers the next menu when it reads the same. It reads only Claude Code's menus, and refuses other agents with unsupported. In a menu without numbers, an option whose label wraps onto a second line reads as two options.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "key": {
                  "description": "escape presses Escape on the menu instead of picking an option",
                  "enum": [
                    "escape",
                  ],
                  "type": "string",
                },
                "label": {
                  "description": "The label of that option as the menu showed it",
                  "type": "string",
                },
                "menuToken": {
                  "description": "The menuToken of the menu this call answers, from a call with session alone; omit to only read the menu",
                  "type": "string",
                },
                "option": {
                  "description": "The number of the option to pick, a whole number counted from 1; give label with it",
                  "type": "number",
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
            "name": "atc_terminal_choose",
            "outputSchema": {
              "properties": {
                "menu": {
                  "description": "The menu the screen shows, or null when it shows none: after a choice, the menu once the screen settles",
                  "properties": {
                    "menuToken": {
                      "description": "The token a choice on this menu gives; it changes with the text, a label or a box, and not with the cursor",
                      "type": "string",
                    },
                    "options": {
                      "items": {
                        "properties": {
                          "checked": {
                            "description": "Whether the option's box is ticked; null for an option with no box",
                            "type": [
                              "boolean",
                              "null",
                            ],
                          },
                          "highlighted": {
                            "description": "Whether the cursor is on the option",
                            "type": "boolean",
                          },
                          "label": {
                            "description": "The text a choice gives as label",
                            "type": "string",
                          },
                          "option": {
                            "description": "The number a choice gives, counted from 1",
                            "type": "number",
                          },
                        },
                        "required": [
                          "option",
                          "label",
                          "checked",
                          "highlighted",
                        ],
                        "type": "object",
                      },
                      "type": "array",
                    },
                    "text": {
                      "description": "The menu's lines above its options",
                      "type": "string",
                    },
                  },
                  "required": [
                    "text",
                    "options",
                    "menuToken",
                  ],
                  "type": [
                    "object",
                    "null",
                  ],
                },
                "partial": {
                  "description": "true when atc could not read the whole of a long list after the key: menu holds only the options the screen shows, numbered from the top of the screen, so read the menu again before a choice on it. Absent otherwise",
                  "type": "boolean",
                },
                "pressed": {
                  "description": "After a choice, the key atc pressed last: enter or escape. Absent when the call only read the menu",
                  "type": "string",
                },
              },
              "required": [
                "menu",
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
            "description": "Read a session's terminal screen as plain text, as it is now. Use it to see a prompt, a menu or an error the agent printed; atc_terminal_choose reads a Claude Code menu as numbered options and answers it. atc holds screens in memory only: a stopped session keeps its last screen until it is forgotten or the daemon restarts, and a session restored after a restart starts from an empty screen. A session with no screen, such as one spawned headless or one still exited after a restart, refuses the read with session_dead. A session moved from its terminal to a headless run returns its last terminal screen, which no longer changes.",
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
            "description": "Add worktrees, branches or pull requests to the scope a session's record holds. Returns { record }, the record as it stands after; a call that adds nothing returns it unchanged. atc checks every entry, held ones included, as the scope field states, and the first invalid one refuses the whole call with scope_invalid. Nothing is ever removed. A session on a sleeping imp is refused with host_unavailable. Through atc mcp from inside a session, a session cannot add to its own scope or its parent's; a call through atc mcp --http or the gateway carries no caller session, so atc does not check it.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {
                "scope": {
                  "additionalProperties": false,
                  "description": "Worktrees, branches, and pull requests the session may touch beyond its own workspace, at most 64 of each. atc checks worktrees and branches on the session's host and pull requests with gh on the atc daemon's host. The first invalid or unknown entry refuses the whole scope with scope_invalid naming it, and atc records none of it. A valid scope goes into the session's record, which the session reads at $ATC_SESSION_RECORD.",
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
            "outputSchema": {
              "properties": {
                "record": {
                  "description": "the session's record as it stands after the call",
                  "properties": {
                    "revision": {
                      "description": "counts from 1 and grows with each change to the record",
                      "type": "number",
                    },
                    "scope": {
                      "description": "the session's workspace and the worktrees, branches and pull requests it may touch beyond it",
                      "type": "object",
                    },
                    "session": {
                      "description": "the atc session id the record belongs to",
                      "type": "string",
                    },
                    "target": {
                      "description": "the execution target the session runs on",
                      "type": "string",
                    },
                    "updatedAt": {
                      "description": "when the record last changed, in ISO 8601",
                      "type": "string",
                    },
                  },
                  "type": "object",
                },
              },
              "required": [
                "record",
              ],
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Rename, pin, or detach a session. A name has three sources, strongest first: the agent's own /rename, a name given at spawn or set here, and an auto-summary. A name set here replaces any name except one the agent set: then the call keeps the agent's name and returns text that starts "updated, not renamed" and states why. Otherwise it returns the text updated whenever the session exists, a call that changes nothing included, so read the session with atc_session_get to see the change. A pinned session cannot be forgotten and leads the TUI's list; atc_sessions_list keeps creation order. A sub-session follows its parent: it pins with the parent, so while the parent is pinned only a call from inside the parent can forget it; it stops when its live parent stops, and a remote client reaches it only when the client reaches the parent and every sub-session of it. A pin set on a sub-session itself stops every caller from forgetting it, its parent included, and keeps it listed as a top-level session when its parent is forgotten. parent null detaches a sub-session: it becomes top-level, so its own pin and forget apply and the former parent keeps its pin. Detaching a top-level session changes nothing. A session cannot move under another parent. A detach or a pin of a sub-session that runs in its parent's imp is refused with bad_args, since that imp sleeps and is destroyed with its parent, and nothing else in that call applies, a rename included.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "name": {
                  "description": "New display name; omit to keep",
                  "type": "string",
                },
                "parent": {
                  "description": "null detaches the session from its parent and makes it top-level; omit to keep. No other value is taken.",
                  "type": "null",
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
            "description": "Stop a session's agent process. The session stays in the list as exited; atc_session_forget removes it. Returns { stopped: true } when the call stopped or suspended a live process, and { stopped: false } when the session had already exited, which changes nothing. A live session's live sub-sessions stop with it; stopping an exited session leaves its sub-sessions running. On an imp the host is suspended, not destroyed: a session that owns its host puts the host to sleep with every session on it, their processes kept for a later atc_session_adopt, and the call fails with host_leased or host_unavailable while the host cannot sleep. A sub-session that shares its parent's imp host is killed instead, and so is a sub-session on an imp of its own when its parent stops and that host fails to suspend. An unknown id is refused with no_such_session.",
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
                  "description": "true when the call stopped a live process, or put it to sleep inside a suspended imp host; false when the session had already exited",
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
            "description": "Remove a session from the list for good. On an imp target this destroys the host and everything on it, so it takes two calls: the first changes nothing and returns confirmToken, valid for 60 seconds; the second, with that token, returns { forgotten: true, destroyed: true }. The second call spends the token before it destroys anything, so a destroy that fails needs a new token from a call without one; a spent, expired or unknown token is refused with confirm_token_invalid. A sub-session that shares its parent's imp host needs the token too but keeps the host (destroyed: false). On any other target one call returns { forgotten: true, destroyed: false }. Refused: a live session unless stop is true, a pinned session, and a sub-session of a pinned session (unpin it, or detach the sub-session with parent null, through atc_session_update first). One exception: a call from inside a session may forget its own sub-sessions while that session is pinned, but not one that carries a pin of its own. Live sub-sessions on a host that survives move to the top level, and so do sub-sessions with a pin of their own and sub-sessions on an imp of their own. A sub-session asleep in its parent's imp host is refused with unsupported_operation (problem host_asleep): adopt it, or forget its parent, first.",
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
            "outputSchema": {
              "properties": {
                "confirmToken": {
                  "description": "on the first call on an imp target, the token the second call passes; the call forgot nothing",
                  "type": "string",
                },
                "destroyed": {
                  "description": "true when the forget also destroyed the imp host the session owned",
                  "type": "boolean",
                },
                "expiresAt": {
                  "description": "when confirmToken stops working, in epoch milliseconds on the daemon's clock",
                  "type": "number",
                },
                "forgotten": {
                  "description": "true once atc removed the session from the list",
                  "type": "boolean",
                },
              },
              "type": "object",
            },
          },
          {
            "annotations": {
              "destructiveHint": true,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Start a terminal for a session that has none, resuming its agent session, as the TUI's P key does: a session a restore left without a terminal, an exited session such as one atc_session_stop stopped, or one that runs headless. A headless turn still running stops before the terminal is set up, and it stays stopped when that setup is then refused, such as with auth_rebind_required: the session is left with neither the turn nor a terminal, so adopt a session that runs a headless turn only when you mean to end that turn. On an imp the host wakes first, every other session asleep on it revives, and a harness still running there is attached instead of started again, unless it launched under an older auth revision than its host holds, which ends it and starts a new one that resumes the agent session; the call returns after those revives. Use it after atc_session_auth_rebind for a session whose restore was refused with auth_rebind_required. Returns { adopted: true } once the terminal starts; that does not show the agent booted, so check with atc_session_get or atc_terminal_read. Refused with session_dead when atc finds nothing to resume, an unknown session id included, which leaves the session as it was. A pin never refuses an adopt. A remote client is refused with no_such_session for a session whose tree runs on a target outside its reach, as atc_session_stop and atc_session_forget refuse it. Refused with no_such_session when the session already has a terminal or another adopt of it runs; that refusal, and a refusal of the session's target, can come after a running headless turn stopped. A retry once the terminal runs is refused and starts nothing.",
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
            "name": "atc_session_adopt",
            "outputSchema": {
              "properties": {
                "adopted": {
                  "description": "true once atc started or attached the session's terminal; it does not show the agent booted",
                  "type": "boolean",
                },
              },
              "required": [
                "adopted",
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
            "description": "Bind the runtime auth of a session's host to the auth profiles its agent selects now, at the next revision. Use it when atc_session_adopt or a restore is refused with auth_rebind_required because the agent's auth profiles changed, or with auth_blocked after a revoke or a failed rebind; then start the session with atc_session_adopt, since a rebind starts nothing. The host gains every grant the agent's auth profiles now select and loses every grant they no longer select, for every session on that host. A harness keeps the settings it launched with until its next launch, and a rebind restarts none: restart a running session with atc_session_stop then atc_session_adopt. Returns { revision, restartPending }: the new revision, and the sessions on the host whose harness still holds an older revision's settings. Open to the daemon's owner only: a remote client is refused with unauthorized. Refused with unsupported_operation for a host with no auth binding, or for an agent that takes no credential from impd's broker, such as one whose auth block was dropped from the config: put the block back, or forget the session. Refused with auth_blocked while the binding is in another state, such as a revoke still pending. Launches on the host are refused with auth_blocked while a rebind runs. A rebind whose grant step fails leaves the host blocked at its old revision until a rebind succeeds; one refused before that step leaves the binding as it was. Each call that succeeds moves the binding to a new revision, a retry included.",
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
            "name": "atc_session_auth_rebind",
            "outputSchema": {
              "properties": {
                "restartPending": {
                  "description": "the ids of the sessions on the host whose harness launched under an older revision and keeps that revision's settings until its next launch; empty when none",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "revision": {
                  "description": "the revision the host's runtime auth binding holds after the rebind",
                  "type": "number",
                },
              },
              "required": [
                "revision",
                "restartPending",
              ],
              "type": "object",
            },
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
            "description": "List the directories earlier spawns used, newest first, as candidates for atc_session_spawn's cwd. The list merges every target and drops which one each path came from, so a path can be on another host. atc checks neither that a directory still exists nor that a spawn takes it: a directory atc picked for a git workspace is in the list, and a spawn with a workspace refuses an existing cwd. A remote client sees only the directories of targets it reaches. Under the gateway, daemon picks whose history to read; without it the default daemon's.",
            "inputSchema": {
              "$schema": "https://json-schema.org/draft/2020-12/schema",
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
            "name": "atc_recent_dirs_list",
            "outputSchema": {
              "properties": {
                "dirs": {
                  "description": "the directories, newest first, each a path on the host the spawn ran on",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
              },
              "required": [
                "dirs",
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
            "description": "Read what atc_session_spawn accepts on this daemon: each agent (pass its id as agent) with whether it is installed, its capabilities, and the model and effort values it takes; each execution target (pass its id as target) with whether it is available; and spawnDefaults. A spawn that would fail says so in advance: an agent with installed false or capabilities.spawn false, a target with available false, or an entry in targetErrors, with their meanings in the output schema. available true does not show that the host of the target is up. A remote client sees only the targets it reaches, and no config-wide targetErrors. Under the gateway it returns daemons, an object keyed by daemon name that holds the state of each daemon and, for a daemon that is up, the object a single daemon returns. It never holds credentials, environment values or endpoints.",
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
                                "description": "applied, or unverified when the backend may ignore the option; null when the agent takes no such option; a later daemon may add a value",
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
                                "description": "applied, or unverified when the backend may ignore the option; null when the agent takes no such option; a later daemon may add a value",
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
                  "description": "a digest of the target config the daemon read at start; it changes only when the daemon restarts with another config",
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
                        "description": "what the problem affects: config, targets, target or defaultTarget; a later daemon may add a value",
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
                        "description": "whether the daemon has a provider of the target's kind; it does not show the target's host is up",
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
            "description": "Read one session: its entry as atc_sessions_list shows it, the prompt it was spawned with, when atc last recorded activity for it, pending (an object with the agent's notification text while it is needs_you, such as "Claude needs your permission"; never a menu's options), result (the final reply of its latest finished turn) and sessionRecord (the scope atc recorded for it). atc_terminal_choose reads and answers a Claude Code menu, such as a permission prompt; a person answers any other agent's menu in the TUI. An unknown session, or one a remote client cannot reach, is refused with no_such_session.",
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
            "outputSchema": {
              "properties": {
                "lastActivityAt": {
                  "description": "when atc last recorded an event for the session, else when it was created, in epoch milliseconds",
                  "type": "number",
                },
                "pending": {
                  "description": "while the session is needs_you, { message } with the agent's notification text, such as "Claude needs your permission"; never a menu's options; else null",
                  "properties": {
                    "message": {
                      "type": "string",
                    },
                  },
                  "type": [
                    "object",
                    "null",
                  ],
                },
                "prompt": {
                  "description": "the prompt the session was spawned with; null without one",
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "result": {
                  "description": "the final reply of the latest finished turn; null before one",
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "session": {
                  "description": "the entry atc_sessions_list shows",
                  "properties": {
                    "agent": {
                      "description": "the agent id the session runs",
                      "type": "string",
                    },
                    "alive": {
                      "description": "whether atc holds a live process for the session",
                      "type": "boolean",
                    },
                    "createdAt": {
                      "description": "when atc created the session, in epoch milliseconds",
                      "type": "number",
                    },
                    "cwd": {
                      "description": "the session's working directory on its host",
                      "type": "string",
                    },
                    "id": {
                      "description": "the atc session id; under the gateway it starts with the daemon's name",
                      "type": "string",
                    },
                    "kind": {
                      "description": "pty for a terminal session, headless for a headless one",
                      "type": "string",
                    },
                    "lastMsg": {
                      "description": "atc's one-line summary of the session's latest state",
                      "type": "string",
                    },
                    "lifecycle": {
                      "description": "the wanted and actual state of the session's host, harness and attachment",
                      "type": "object",
                    },
                    "locator": {
                      "description": "the daemon and target the session runs on",
                      "type": "object",
                    },
                    "model": {
                      "description": "the model the spawn asked for; absent when the agent's default runs",
                      "type": "string",
                    },
                    "name": {
                      "description": "the session's display name",
                      "type": "string",
                    },
                    "parent": {
                      "description": "the id of the session this one is a sub-session of; absent on a top-level session",
                      "type": "string",
                    },
                    "pinned": {
                      "description": "whether the session carries a pin of its own",
                      "type": "boolean",
                    },
                    "state": {
                      "description": "running, needs_you, done or exited; the atc_sessions_list description holds their meanings, and a later daemon may add a value",
                      "type": "string",
                    },
                    "unread": {
                      "description": "whether the session has news no one has read",
                      "type": "boolean",
                    },
                    "workspace": {
                      "description": "the repository and commit atc checked out for the session; absent without a workspace source",
                      "type": "object",
                    },
                  },
                  "required": [
                    "id",
                    "name",
                    "cwd",
                    "agent",
                    "state",
                  ],
                  "type": "object",
                },
                "sessionRecord": {
                  "description": "the scope atc recorded for the session; null when it holds none",
                  "properties": {
                    "revision": {
                      "description": "counts from 1 and grows with each change to the record",
                      "type": "number",
                    },
                    "scope": {
                      "description": "the session's workspace and the worktrees, branches and pull requests it may touch beyond it",
                      "type": "object",
                    },
                    "session": {
                      "description": "the atc session id the record belongs to",
                      "type": "string",
                    },
                    "target": {
                      "description": "the execution target the session runs on",
                      "type": "string",
                    },
                    "updatedAt": {
                      "description": "when the record last changed, in ISO 8601",
                      "type": "string",
                    },
                  },
                  "type": [
                    "object",
                    "null",
                  ],
                },
              },
              "required": [
                "session",
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
            "description": "Read a session's conversation log a page at a time, oldest first: user and assistant messages, with tool uses summarised. Pass the returned cursor to continue; more is true when the page stopped at limit or at its size cap, even when the log ends there, so a page with no rows ends the read. A cursor from before the session moved to a new log file reads the new log from its start. A line over 1 MiB is skipped. Claude and Claude-compatible agents only; other agents return unsupported, and an unknown session returns no_such_session.",
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
            "outputSchema": {
              "properties": {
                "cursor": {
                  "description": "the cursor after this page; pass it on the next call",
                  "type": "string",
                },
                "more": {
                  "description": "true when the page stopped at limit or at its size cap, even when the log ends there; false at the end of the log",
                  "type": "boolean",
                },
                "rows": {
                  "description": "the messages on this page, oldest first",
                  "items": {
                    "properties": {
                      "at": {
                        "description": "when the message was written, in epoch milliseconds; null when the log holds no time",
                        "type": [
                          "number",
                          "null",
                        ],
                      },
                      "role": {
                        "description": "user or assistant",
                        "type": "string",
                      },
                      "text": {
                        "description": "the message's text",
                        "type": "string",
                      },
                      "tools": {
                        "description": "the tool uses in the message, each with its name and a summary of its input",
                        "type": "array",
                      },
                    },
                    "type": "object",
                  },
                  "type": "array",
                },
              },
              "required": [
                "rows",
                "cursor",
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
            "description": "Read the fleet's event feed: the one call to catch up on session state changes, the notes sessions send, and the progress of messages you sent, oldest first. To wait on one message, use atc_message_get; for a session's conversation itself, use atc_transcript_read. It holds session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-queued, message-delivered, message-answered with the full answer, cut at 64 KiB, message-unanswered, each with the message id), answer notice events under the sending session (notice-queued, notice-delivered, with the message id) and notes (note, with its label and full text, cut at 64 KiB). Pass the returned cursor on the next call; more true means the page stopped early, so read again at once. Without a cursor it returns the latest events, and more never counts the older ones. waitMs holds the call until an event arrives, up to 30000; use it instead of polling. session limits the read to one session; previewOnly true returns 600-character previews of notes and answers instead. atc deletes events older than 30 days, except the newest event of each session. A partial read says so: complete false or textError on a note or an answer, and, under the gateway, unavailable, started or truncated, with their meanings in the output schema.",
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
                  "description": "true returns each note and each answer as its 600-character preview instead of its full text; defaults to false",
                  "type": "boolean",
                },
                "session": {
                  "description": "An atc session id; limits the read to that session's events. On one daemon a cursor stays valid across filtered and unfiltered reads; under the gateway a cursor holds only for the session filter it was read under, and another filter refuses it with bad_args",
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
                  "description": "the cursor after the last event on the page; pass it on the next call",
                  "type": "string",
                },
                "events": {
                  "items": {
                    "properties": {
                      "at": {
                        "description": "when the event happened, in epoch milliseconds",
                        "type": "number",
                      },
                      "complete": {
                        "description": "false: atc kept only the preview of this note or answer, and text holds it. A text cut at 64 KiB reads true",
                        "type": "boolean",
                      },
                      "cursor": {
                        "description": "the cursor at this event; pass it to read on from after the event",
                        "type": "string",
                      },
                      "detail": {
                        "description": "the event's detail, at most 600 characters; for a note or a message-answered event, the preview of its text or answer; null when the event has none",
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
                        "description": "on a note, the note's label",
                        "type": "string",
                      },
                      "message": {
                        "description": "on a message or notice event, the message id, for atc_message_get",
                        "type": "string",
                      },
                      "name": {
                        "description": "the session's current name; null when atc no longer lists the session",
                        "type": [
                          "string",
                          "null",
                        ],
                      },
                      "session": {
                        "description": "the atc session id the event belongs to",
                        "type": "string",
                      },
                      "text": {
                        "description": "on a note, the text atc stored; on a message-answered event, the answer atc stored; each cut at 64 KiB; absent with previewOnly or textError",
                        "type": "string",
                      },
                      "textError": {
                        "description": "the text of the note or answer did not load: its read failed, or the 10 seconds every text read on the page shares ran out; detail holds the preview",
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
                  "description": "true when events after this page wait to be read, so read again at once; a read without a cursor never counts the older events it skipped",
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
            "description": "Send a message to a session's agent and get its id back. The message goes into the agent's conversation, never into the terminal, and the agent's answer is stored on the message. Sent from inside an atc session that takes messages, the outcome also reaches your own conversation by itself as an <atc-answer id="..." status="answered|unanswered"> notice once the message is answered or unanswered; it needs no reply and no atc_message_get call. A caller with no inbox (outside a session, a remote client, or a session whose agent takes no messages) follows with atc_message_get and waitMs until status is answered or unanswered. status is queued (waiting in atc's inbox), delivered (handed to the session, not yet confirmed as seen by the model), answered, or unanswered: the turn that carried the message ended without an answer (interrupted, an error, a refusal, or the prompt never started a turn) or the session's process ended while atc held the message delivered, with the cause in unansweredReason. A message still queued when the process ends stays queued for the session's next process. A message to a session that waits for its restore after a daemon restart queues the same way, and atc hands it to the session's message bridge once the bridge attaches. unanswered is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith in atc_message_get lists the others. Refused: unsupported when the agent takes no messages (capabilities.message false in atc_spawn_options_get), or when its message bridge has not attached 15 seconds after the session started; session_dead when the session's state is exited in atc_sessions_list, an asleep session included: start it again with atc_session_adopt, then send; no_such_session for an unknown id. The call cannot say who the message is from: atc labels it with the caller, a remote client by its client name, a session by its session id and name, and any other caller as the owner, and the receiving agent sees that label. A retry with the same idempotencyKey and text returns the same message with its current status. A refused send leaves no key on the daemon, so send it again under a new key: under the gateway, a retry with the same key returns outcome_unknown and sends nothing.",
            "inputSchema": {
              "additionalProperties": false,
              "properties": {
                "idempotencyKey": {
                  "description": "A key, unique to this call, that makes a retry safe: retrying with the same key and arguments acts only once and returns what the first call made as it stands now, and the same key with different arguments is refused as idempotency_conflict. A call refused with an error such as session_dead leaves no key on the daemon, so retry it under a new key: the same key runs the call again on a daemon reached directly, but under the gateway it returns outcome_unknown and runs nothing. atc forgets a key 24 hours after its call completed. A call interrupted mid-way is refused as outcome_unknown, with the id it acted under in data.effectRef. At most 180 characters",
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
                  "description": "the message id, for atc_message_get",
                  "type": "string",
                },
                "status": {
                  "description": "queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value",
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
            "description": "Read one message sent with atc_message_send. A sender inside an atc session that takes messages gets the outcome as an <atc-answer> notice. Every other caller has no inbox, so this read is how it learns the outcome: a caller outside a session, a remote client, or a session whose agent takes no messages (capabilities.message false in atc_spawn_options_get). A caller may also use it to wait on one message. It returns the message with its status (queued, delivered, answered or unanswered), the answer once answered and unansweredReason once unanswered; the output schema holds the meaning of each field. unanswered means the turn that carried the message ended without an answer, or the process of its session ended while the message was delivered (unansweredReason session_ended), and is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith lists the others. Pass waitMs, up to 30000, to hold the call until the status changes; an answered or unanswered message returns at once. Ids and statuses persist, so call again after a timeout. An unknown id, or one whose session the caller cannot see, is refused with bad_args.",
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
                  "description": "the text the session sent with the answer tool or, if none, the final reply of the turn that answered the message, cut at 64 KiB; present only on an answered message",
                  "type": "string",
                },
                "answeredAt": {
                  "description": "when atc stored the answer, in epoch milliseconds",
                  "type": "number",
                },
                "answeredWith": {
                  "description": "the ids of the other messages to the same session that the same turn answered and the caller can see; this message is never among them",
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "deliveredAt": {
                  "description": "when atc handed the message to the session, in epoch milliseconds",
                  "type": "number",
                },
                "from": {
                  "description": "The sender's name, the same as sender.name; on a message stored before atc labelled senders, the name its sender gave",
                  "type": "string",
                },
                "message": {
                  "description": "the message id",
                  "type": "string",
                },
                "sender": {
                  "description": "Who sent the message, as atc labelled it from the caller; no caller sets it. kind is connector (a remote client, its OAuth client id in client and its client name in name), session (an atc session, its id in session and the name it had when it sent in name), or owner (the user's own atc command line, name owner); a later daemon may add a kind. Absent on a message stored before atc labelled senders",
                  "properties": {
                    "client": {
                      "type": "string",
                    },
                    "kind": {
                      "type": "string",
                    },
                    "name": {
                      "type": "string",
                    },
                    "session": {
                      "type": "string",
                    },
                  },
                  "type": "object",
                },
                "sentAt": {
                  "description": "when atc queued the message, in epoch milliseconds",
                  "type": "number",
                },
                "session": {
                  "description": "the atc session id the message went to",
                  "type": "string",
                },
                "status": {
                  "description": "queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value",
                  "type": "string",
                },
                "text": {
                  "description": "the text that was sent",
                  "type": "string",
                },
                "turn": {
                  "description": "the id of the agent's turn whose final reply answered the message or that ended without an answer; null for an answer sent with the answer tool, and while atc holds none",
                  "type": [
                    "string",
                    "null",
                  ],
                },
                "unansweredAt": {
                  "description": "When atc marked the message unanswered; present only on an unanswered message",
                  "type": "number",
                },
                "unansweredReason": {
                  "description": "Why the turn ended without an answer: interrupted (a person stopped the turn), error (the turn failed), refusal (the model declined), not_started (the prompt never started a turn), or session_ended (the process of the session ended before the turn did); present only on an unanswered message",
                  "type": "string",
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
          name: 'atc_terminal_choose',
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
          name: 'atc_session_adopt',
          annotations: {
            readOnlyHint: expect.toBeBoolean(),
            destructiveHint: expect.toBeBoolean(),
            openWorldHint: expect.toBeBoolean(),
          },
        }),
        expect.objectContaining({
          name: 'atc_session_auth_rebind',
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
      agents: {
        claude: { kind: 'claude', bin: ctx.claudeBin },
        grok: { kind: 'grok', bin: ctx.grokBin },

        // A codex binary on the host would change the served tool descriptions.
        codex: { kind: 'codex', bin: '/nonexistent/codex' },
      },
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
