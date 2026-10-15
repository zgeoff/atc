# Tools in a Claude subscription session

A stock Claude entry that signs in with a [Claude subscription on imps](./claude-subscription.md)
can give its sessions tools whose credentials impd holds: MCP servers over HTTP, and API keys for
the scripts the session runs. The session holds `imp-broker-placeholder` in place of each
credential, and impd swaps in the credential on requests to the profile's host.

## MCP servers on imps

`mcpServers` in a stock entry's `auth` gives each subscription session on an imp an MCP server over
HTTP whose credential impd holds. The session sends `Bearer imp-broker-placeholder` in the header
that the server's profile sets, and impd swaps in the credential for the server's host, so the
credential never enters the imp. To give sessions Linear's MCP server with a Linear personal API
key:

1. Add the key to impd as a `custom` secret on `mcp.linear.app`, with the value on stdin:

   ```bash
   impz secret add linear-imp-agents --kind=custom --hosts=mcp.linear.app --header=authorization --scheme=bearer
   ```

2. List the secret in the `--grantable` secrets of the target's impd token.
3. Add a profile for the secret, select it in the entry's `auth`, and point a server at it:

   ```json
   {
     "authProfiles": {
       "linear": {
         "secret": "linear-imp-agents",
         "host": "mcp.linear.app",
         "header": "authorization",
         "scheme": "bearer"
       }
     },
     "agents": {
       "claude": {
         "auth": {
           "profiles": ["claude", "github", "linear"],
           "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp", "profile": "linear" } }
         }
       }
     }
   }
   ```

Each server holds `url` and `profile` alone. atc writes the servers to an MCP config file in the
session's guest folder and passes it with `--mcp-config`, so Claude Code starts them without an
approval prompt. atc leaves a server out, prints the reason when the daemon starts, and keeps the
entry when any of these holds:

- `profile` is not in the entry's `auth.profiles`, or is not a `custom` profile.
- `url` is not https, has a port or user info, or its host is not the profile's `host`.
- The server's name holds a character other than a letter, a digit, `_`, or `-`.

A revoked grant leaves the placeholder in the request, and the server returns `401`. The tool call
then fails with `MCP server "linear" rejected the Authorization header in its config`, and `/mcp`
lists the server as `needs authentication`. The session has no other credential for the server. On
the local target, Claude keeps the MCP servers of your own Claude config.

## API keys for a session's own tools

`placeholderEnv` in a stock entry's `auth` gives each subscription session on an imp a variable that
holds `imp-broker-placeholder` in place of an API key impd holds, for the scripts and tools the
session runs. impd swaps in the key when a request carries the placeholder to the profile's host, so
the key never enters the imp. To give a session's eval scripts the Jev key in `TYPESAFE_API_KEY`:

1. Add the key to impd as a `custom` secret on `api.typesafe.ai`:

   ```bash
   impz secret add jev-imp-agents --kind=custom --hosts=api.typesafe.ai
   ```

2. List the secret in the `--grantable` secrets of the target's impd token.
3. Add a profile for the secret, select it in the entry's `auth`, and bind the variable to it:

   ```json
   {
     "authProfiles": {
       "jev": {
         "secret": "jev-imp-agents",
         "host": "api.typesafe.ai",
         "header": "authorization",
         "scheme": "bearer"
       }
     },
     "agents": {
       "claude": {
         "auth": {
           "profiles": ["claude", "jev"],
           "placeholderEnv": { "TYPESAFE_API_KEY": { "profile": "jev" } }
         }
       }
     }
   }
   ```

Each variable holds `profile` alone, and atc sets its value. A placeholder can never stand in for an
Anthropic credential, so atc refuses the entry and prints the reason when the daemon starts when any
of these holds:

- The variable starts with `ANTHROPIC_`, `CLAUDE_`, `CODEX_`, `OPENAI_`, or `ATC_`, is `HOME`,
  `PATH`, or `TMPDIR`, or is a proxy or CA variable, in either case. Claude Code, the Codex CLI the
  session runs, atc, or impd reads each of these.
- `profile` is not in the entry's `auth.profiles`, or is not a `custom` or `oauth` profile.
- The profile's `host` is `anthropic.com`, `claude.ai`, `claude.com`, or a host under one of them.
- The entry's `env` or `settings.env`, or a selected profile's `env`, sets the variable, which would
  replace the placeholder or be replaced by it.

The old `claudeAuth` key takes no `placeholderEnv`.
