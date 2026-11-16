# Journey commands in atc

Read this file before you run or write a journey, the `bash` block in each `feature-*.md` file
beside this one. This file holds the atc rules that `bun verify <command> --help` leaves out. Start
every journey line with `bun verify`. Each line acts on the daemon that `bun verify up` started, so
run `up` and `doctor` first, as steps 2 and 3 of [SKILL.md](../SKILL.md) say.

- Give each session a name that starts with `wv-`, followed by lowercase letters, digits or hyphens,
  such as `wv-spawn`. `action spawn-session`, `action stop-session` and `action forget-session`
  refuse any other name.
- When a journey line fails, run the journey's `action forget-session` line before you go on. A
  session you leave behind shows up in the session lists of every later journey.
- Press a letter in either case, or a named key with modifiers, with `terminal press <key>`, such as
  `A`, `shift+tab` or `ctrl+a`. `terminal press` refuses a symbol that needs shift, such as `!` or
  `?`. Send those with `terminal type --text <text>`.
- Read the daemon's database with `db query`. The database's `fleet` table holds one row per
  session.
- Pass `--server <name>` to each `mcp` command. `bun verify up` starts each server and gives each
  gateway its token. Pick the server for the path your feature covers:
  - `atc`: `atc mcp` over stdio;
  - `remote`: `atc mcp --http`;
  - `gateway`: atc-gateway, with the daemon's token;
  - `gateway-wrong`: atc-gateway with a wrong token. The daemon refuses the gateway, so each call
    returns an empty `sessions` list and the daemon's `state` as `unauthorized`.
