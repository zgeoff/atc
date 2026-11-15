# Journey commands in atc

Follow these when you run or write a journey in atc. `--help` does not print them.

- Type a capital letter with `terminal type --text K`: `terminal press` refuses a shifted key.
- Name each session `wv-` and a word, such as `wv-spawn`. Run a journey's cleanup lines after a
  failure too.
- `db query` reads the daemon's database; its `fleet` table has a row per session.
- Pass `--server` to each `mcp` command: `atc` is `atc mcp` over stdio, `remote` is
  `atc mcp --http`, and `gateway` and `gateway-wrong` are the gateways.
