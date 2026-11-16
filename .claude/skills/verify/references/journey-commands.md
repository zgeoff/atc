# Journey commands in atc

Read this before you run or write a journey, the `bash` block in a feature file. It holds the atc
rules that `bun verify <command> --help` leaves out. Each command below is a `bun verify` command,
and runs against the daemon that `bun verify up` started in its temp home.

- Name each session `wv-` and lowercase letters, digits or hyphens, as in
  `action spawn-session --name wv-spawn`. The session actions refuse any other name.
- When a journey line fails, still run the journey's `action forget-session` line, so the session
  leaves the run.
- Send a capital letter with `terminal type --text <letters>`. `terminal press` takes one key or
  chord, such as `a` or `ctrl+space`, and refuses a shifted key.
- Read the daemon's database with `db query`. Its `fleet` table holds one row per session.
- Pass `--server <name>` to each `mcp` command, with one of these names:
  - `atc`: `atc mcp` over stdio;
  - `remote`: `atc mcp --http`;
  - `gateway`: atc-gateway, with the daemon's token;
  - `gateway-wrong`: atc-gateway with a wrong token, which the daemon refuses.
