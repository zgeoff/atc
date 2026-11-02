---
name: project-testing
description:
  "atc's test facts, and its own test topics beside the shared testing skill: where a suite lives,
  the per-run test home, the stand-in agent CLIs, the lanes, the PTY harness that drives the real
  TUI, and socket writes. Load it beside testing before you design, write or review an atc test."
metadata:
  kind: rule-set
---

# atc testing

## Facts

| Fact       | Where                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lanes      | the table under [Lanes](#lanes), and the `lanes` option of `zgeoff/test-beside-module` and `zgeoff/max-test-timeout` in [`.oxlintrc.json`](../../../.oxlintrc.json) |
| Test utils | [`packages/test-utils/src/`](../../../packages/test-utils/src/)                                                                                                     |

## Departures

None.

## Where a suite lives

- Put a unit test beside its module in the package's `src/`.
- Put a flow across several packages in `integration/` at the repo root when it runs in the test's
  own process, with stand-ins such as `startTestDaemon` or `createStubExecutionProvider`.
  `bun run test` runs it, and fails any test that runs past 5 s.
- Put a suite in `e2e/` at the repo root when it starts the `atc` CLI, the daemon or `atc-gateway`
  as a process, through `runATC`, `startDaemonProcess`, `startMCPStdio` or `startTUIHarness`, or by
  running `atc-gateway`. Only the `e2e` lane runs it. Start the file name with `daemon-` or
  `gateway-` only for a suite that runs against the compiled binary: CI runs those suites only in
  the smoke job of `binaries.yml`.

## The test home

- Run tests only through `bun run test` and the other test scripts. Each starts Bun through
  [`with-test-home.sh`](../../../scripts/with-test-home.sh), which points `HOME`, the XDG folders
  and the agent CLIs' homes at a new temp folder, and kills any process a test left behind. A bare
  `bun test` fails before any test runs: a home set in a preload never reaches a test's
  subprocesses, so the [`isolate-home`](../../../packages/test-utils/src/isolate-home.ts) preload
  refuses the run.
- Get a home path from [`resolveHomeDir`](../../../packages/contract/src/light/resolve-home-dir.ts),
  never from `os.homedir()`. Bun reads `HOME` for `os.homedir()` once, at startup.
- Change an environment variable through
  [`updateEnv`](../../../packages/test-utils/src/update-env.ts). The isolate-home preload puts the
  old value back after the test.
- After you add code or a test that writes to a home, run `bun run test:isolation`. It runs the
  suite in a home of canary files, and fails when a test reads, changes or adds to one. It can catch
  a read only on a filesystem that updates access times, so trust its Linux run in CI over a local
  pass.

## Agent CLIs

- Never run the real `claude` binary in a test. Drive a stand-in, such as the PTY harness's stand-in
  `claude`. Search [`packages/test-utils/src/`](../../../packages/test-utils/src/) for `stub` to
  find the others. `bun run test:isolation` puts a canary `claude` first on `PATH`, and fails when a
  test runs it.
- Only `bun run test:atc-bridge` runs the real binary: it runs `claude plugin validate` and
  `claude plugin test` on the Claude Code mod in `mods/atc-bridge/`. Neither starts a session.
- When you test the lock on Claude's config file, test it against `proper-lockfile`, the lock
  library Claude Code bundles, as
  [`with-claude-config-lock.test.ts`](../../../packages/harnesses/claude/src/local-trust/with-claude-config-lock.test.ts)
  does.

## Lanes

Put a suite that needs a real system in a lane, a test script of its own. `bun run test` leaves each
lane's files out, by the patterns in [`bunfig.toml`](../../../bunfig.toml).

| Lane      | Suite                                       | Script                   | Needs                                                                         | Limit per test |
| --------- | ------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- | -------------- |
| e2e       | a file in `e2e/`                            | `bun run test:e2e`       | the `atc` CLI, the daemon or `atc-gateway`, started as a process              | 15 s           |
| Codex     | `<module>.codex.test.ts`, beside the module | `bun run test:codex`     | the Codex CLI on the machine                                                  | 5 s            |
| toolchain | `<module>.toolchain.test.ts`, beside it     | `bun run test:toolchain` | a real `bun install`, type check and test run of a workspace in a temp folder | 15 s           |

- Never add a skip guard to a lane suite. It runs only in its lane, and fails when what the lane
  needs is missing.
- CI installs the Codex CLI at the version that `CODEX_VERSION` in
  [`checks.yml`](../../../.github/workflows/checks.yml) pins.
- Never give a lane test a timeout of its own. The lane's script sets the limit in the table.
- Run one e2e suite with `bun run test:e2e e2e/<file>.test.ts`. You may add `-t` or another option
  that [`with-e2e-paths.sh`](../../../scripts/with-e2e-paths.sh) lists. It refuses anything else, so
  it never runs the whole repo.
- To run the `e2e/daemon-*` and `e2e/gateway-*` suites against a compiled build, as the smoke job of
  `binaries.yml` does, run `test:e2e` with no file, and set `ATC_BIN` and `ATC_GATEWAY_BIN` to the
  built binaries. Write each `e2e/` suite to pass in any order: CI's test job runs the other suites
  from source, in random order.

To add a lane:

1. Add its suffix to the `lanes` option of the lint rules `zgeoff/test-beside-module` and
   `zgeoff/max-test-timeout` in [`.oxlintrc.json`](../../../.oxlintrc.json). The pre-push hook reads
   the lanes there, and leaves their files out of the tests it runs.
2. Add `**/*.<suffix>.test.ts` to `pathIgnorePatterns` in `bunfig.toml`.
3. Add a `test:<suffix>` script to [`package.json`](../../../package.json), modelled on
   `test:codex`.
4. Add a step that runs the script to the `test` job in `checks.yml`.
5. Add the lane's row to the table in this section.

## Worker count

- Set `TEST_WORKERS` to choose how many workers a test script uses. Without it,
  [`read-worker-count.ts`](../../../scripts/read-worker-count.ts) picks up to 4, and 1 on a host
  with less than 4 GiB of memory.
- Change `read-worker-count.ts` in zgeoff/tools, never here: repo-sync copies it into atc.

## The PTY harness

[`startTUIHarness`](../../../packages/test-utils/src/start-tui-harness.ts) runs the real `atc`
client in a `bun-pty` pseudo-terminal, in a new test home.

- Drive the stand-in `claude` that the harness installs from
  [`buildStubTUIClaude`](../../../packages/test-utils/src/build-stub-tui-claude.ts). It reports its
  hook events through the real reporter over the real socket. To change what it reports, write a
  scenario file into the harness's `home`, such as `fake-transcript.jsonl` with a `custom-title`
  line. To list the scenario files, search `buildStubTUIClaude` for `fake-`. Never add a flag to the
  stand-in's script.
- Call `reset()` on the harness before the action whose output you check. The captured output grows
  from boot, so a check that text is absent can pass on a screen drawn earlier.
- Wait with `waitFor` for each key's effect before you send the next key. Two `pty.write()` calls
  can arrive as one chunk, and a control byte followed by a letter can then read as another key.
- Wait for stable text, such as a session name, a box title or a state label. Hint lines change with
  each new keybinding.
- Type control bytes and escape sequences through
  [`KEYS`](../../../packages/test-utils/src/keys.ts), never as raw bytes.

## Sockets

- When you change code that writes to a socket, test it with a slow reader through the real socket:
  send more bytes than one `write()` call accepts, and check that nothing was lost.
  `Bun.socket.write()` returns the bytes it took and drops the rest, so code that never waits for
  the socket to drain loses data, and only such a test shows it.
