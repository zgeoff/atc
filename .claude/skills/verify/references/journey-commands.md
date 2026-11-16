# Journey commands in atc

Read this file before you run or write a journey, the `bash` block in each `feature-*.md` file
beside this one. This file holds the atc rules that `bun verify <command> --help` leaves out. Start
every journey line with `bun verify`. Run `up` and `doctor` first, as steps 2 and 3 of
[SKILL.md](../SKILL.md) say. `up` starts an atc daemon in a temporary home folder of its own, and
each journey line acts on that daemon.

## Sessions

- Start each session name with `wv-`, then lowercase letters, digits or hyphens, such as `wv-spawn`.
  `action spawn-session`, `action stop-session` and `action forget-session` refuse any other name.
  Use a `wv-` name in `mcp call atc_session_spawn` too, so `action forget-session` can remove the
  session.
- End each journey that spawns a session with an `action forget-session` line for that session. When
  a journey line fails, run that line before you go on. `forget-session` stops the session if it
  still runs, removes it from the daemon, and does nothing when no session has the name. A session
  you leave behind shows up in the session lists of every later journey in the same `up`.

## Keys and the database

- Press one key with `terminal press <key>`: a letter in either case, or a named key such as `enter`
  or `tab`, with modifiers such as `shift+tab` or `ctrl+a`. `terminal press` refuses a symbol you
  type with shift, such as `!` or `?`.
- Send text, symbols included, with `terminal type --text <text>`. It sends no Enter, so follow it
  with `terminal press enter` when the app waits for one.
- Read the daemon's SQLite database with `db query "<sql>"`. Its `fleet` table holds one row per
  session. List the columns with `db query "select name from pragma_table_info('fleet')"`.

## MCP servers

Pass `--server <name>` to each `mcp` command. Use `atc` unless your feature covers another path.
Each name below is a server that `bun verify up` starts and the `mcp` commands connect to. For
`remote` and `gateway`, `bun verify` signs in for you, and `doctor` checks the sign-in.

- `atc`: `atc mcp`, over stdio.
- `remote`: `atc mcp --http`, the daemon's MCP server over HTTP.
- `gateway`: atc-gateway, the separate binary that serves the MCP tools of several daemons over
  HTTP. `up` gives it the daemon's token.
- `gateway-wrong`: atc-gateway with a wrong token. The daemon refuses that gateway, so each call
  returns an empty `sessions` list and the daemon's `state` as `unauthorized`.
