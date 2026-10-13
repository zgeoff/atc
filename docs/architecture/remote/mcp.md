# The MCP servers

atc serves its fleet as MCP tools, so an agent can spawn, drive and read other agents. Two servers
share one dispatcher and one tool set: `atc mcp`, a stdio server an agent CLI starts, and
`atc mcp --http`, which serves the same tools over streamable HTTP behind OAuth to a hosted
assistant. Each server is a client of the daemon, and each tool call becomes one daemon request.
atc-gateway serves the same tools for several daemons ([the gateway](./gateway.md)).

[OAuth](./oauth.md) covers how a remote client gets a grant, and the
[remote MCP guide](../../guides/remote-mcp.md) covers running the HTTP server.

## Tools

A tool's name is `atc_<noun>_<verb>`, where the noun is the channel the tool reaches, such as
`atc_terminal_type` or `atc_message_send`. Each tool declares, beside its input schema:

- **Safety annotations**, which the tool listing returns. A read tool is read-only. A tool that can
  end a session or type into one is destructive. A tool that starts an agent or puts text in front
  of one is open-world, because the agent acts on that text outside atc's control.
- **One grant scope** out of `read`, `message`, `spawn` and `kill`, which groups the tool by the
  access it needs ([scopes](#scopes)).

A tool result holds its output as text, and a result that is data also holds it as structured
content with an output schema. The servers speak each MCP protocol revision atc implements, and
leave out the one revision that requires JSON-RPC batching, which atc does not implement. The
`tool-contract` skill holds the rules for naming and describing a tool.

The tool listing follows the daemon the server is connected to: a server hides a tool or an input
whose daemon feature is missing, and refuses a call that needs one with `daemon_outdated` without
sending the daemon anything ([the protocol](../protocol/protocol.md#versions-and-features)).

## Scopes

A grant holds one or more of four scopes, and each tool needs exactly one of them:

- `read` reads the fleet, a session, its terminal, its transcript and the event feed, and changes
  nothing.
- `message` instructs a session's agent, and also renames, pins, detaches and marks a session read.
  Those session changes alter how atc lists and labels a session, and none of them reaches its
  terminal or ends it, so they need no more access than a message does.
- `spawn` starts a session, types into one, and adds to a session's record scope. Typing into a
  terminal takes `spawn`, because a line typed into a session can do anything a new session can.
  Adding to a session's record scope takes `spawn` too, because it widens what a session may touch.
- `kill` stops or forgets a session. A tool atc does not know needs `kill`, the strictest.

A test compares this table with the tool definitions, so a tool added without a row fails it:

| Tool                    | Scope     |
| ----------------------- | --------- |
| `atc_sessions_list`     | `read`    |
| `atc_session_get`       | `read`    |
| `atc_terminal_read`     | `read`    |
| `atc_transcript_read`   | `read`    |
| `atc_events_read`       | `read`    |
| `atc_message_get`       | `read`    |
| `atc_recent_dirs_list`  | `read`    |
| `atc_spawn_options_get` | `read`    |
| `atc_daemons_list`      | `read`    |
| `atc_message_send`      | `message` |
| `atc_session_update`    | `message` |
| `atc_session_mark_read` | `message` |
| `atc_session_spawn`     | `spawn`   |
| `atc_terminal_type`     | `spawn`   |
| `atc_session_scope_add` | `spawn`   |
| `atc_session_stop`      | `kill`    |
| `atc_session_forget`    | `kill`    |

## The stdio server

`atc mcp` boots the daemon when none answers, and serves every grant scope to its caller, since the
caller is an agent the owner started. Started inside a session, it reads that session's id from its
environment, so a spawn makes a sub-session of the caller and a message names the caller as its
sender ([sessions](../daemon/sessions.md#sub-sessions)). When the calling session is gone, a spawn
falls back to a top-level session. The fallback has different params from the call, so it runs under
an idempotency key derived from the caller's, and a retry derives the same key.

## Remote callers

`atc mcp --http` checks a bearer token on every request and serves only the tools its grant's scopes
allow. The tool listing returns every tool whatever the token holds, and a call outside the token's
scopes gets HTTP 403 with `insufficient_scope` and the missing scope, so a client learns what to ask
for. A token without `read` gets tool descriptions that list no agent, since listing agents is a
read.

Every daemon request a remote call makes acts as the OAuth client's id, so the daemon limits it to
the targets the config's `principals` key grants that client
([principals](../protocol/principals.md)). A message from a remote client carries the client's name
as its sender, whatever the call passed, so a client cannot speak as another. The server refuses to
talk to a daemon that predates principals.

## Reconnecting

The stdio server holds one daemon connection for its whole life, so once the daemon restarts, its
calls fail until the agent starts it again. `atc mcp --http` reconnects on its next request instead.
A call in flight at that moment is retried once on the fresh connection only when a retry cannot
double its effect:

- A read-only call is retried.
- A spawn or a message is retried when the fresh daemon supports idempotency keys. The server sends
  the call under a key, the one the caller passed or one it mints, and resends it unchanged under
  the same key, so the daemon answers a key it holds from the key and runs a key it never received
  once ([idempotency](../protocol/idempotency.md)). atc-gateway resends as replay-only instead
  ([the gateway](./gateway.md#lost-answers)).
- Any other call fails, because it must not run twice.

## Reading notes

The events tool returns notes among the fleet's other events, each with its whole text. A page that
reads whole texts is bounded by the total text it holds and by the time it spends reading, and it
stops before the first note that does not fit, so the next call starts at that note and every page
holds at least its first. The answer marks a note it could not read: one whose daemon kept only its
preview, one whose read failed, and, under atc-gateway, the daemons that did not answer, each of
which keeps its place in the cursor. A caller that wants previews only asks for them and skips the
reads.
