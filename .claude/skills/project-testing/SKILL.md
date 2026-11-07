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

| Fact       | Where                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| Lanes      | [`rig.config.ts`](../../../rig.config.ts), and the table under [Lanes](#lanes) |
| Test utils | [`packages/test-utils/src/`](../../../packages/test-utils/src/)                |

## Departures

None.

## Where a suite lives

- Put a unit test beside its module in the package's `src/`.
- Put a flow across several packages in `integration/` at the repo root when it runs in the test's
  own process, with stand-ins such as
  [`startTestDaemon`](../../../packages/daemon/src/testing/start-test-daemon.ts) or
  [`createStubExecutionProvider`](../../../packages/execution/local/src/testing/create-stub-execution-provider.ts).
  The unit run, `bun run test`, runs it, and fails any test that runs past 5 s.
- Put a suite in `e2e/` at the repo root when it starts the `atc` CLI, the daemon or `atc-gateway`
  as a process, through [`runATC`](../../../packages/test-utils/src/run-atc.ts),
  [`startDaemonProcess`](../../../packages/lifecycle/src/testing/start-daemon-process.ts),
  [`startMCPStdio`](../../../packages/test-utils/src/start-mcp-stdio.ts) or
  [`startTUIHarness`](../../../packages/test-utils/src/start-tui-harness.ts), or by running
  `atc-gateway`. Only the `e2e` lane runs it.
- Start an e2e file name with `daemon-` or `gateway-` when the suite checks the compiled binary. CI
  runs those suites only in the smoke job of
  [`binaries.yml`](../../../.github/workflows/binaries.yml), with `ATC_BIN` and `ATC_GATEWAY_BIN`
  set to the compiled binaries, and never from source. To do the same, run `test:e2e` with no file
  and both variables set.

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
  suite in a home of canary files, and fails when a test reads, changes or adds to one. It catches a
  read only on a filesystem that updates access times, so trust its Linux run in CI over a local
  pass.

## Agent CLIs

- Never run the real `claude` binary in a test. Drive a stand-in, such as the PTY harness's stand-in
  `claude`. Search [`packages/test-utils/src/`](../../../packages/test-utils/src/) for `stub` to
  find the others. `bun run test:isolation` puts a canary `claude` first on `PATH`, and fails when a
  test runs it.
- Only `bun run test:atc-bridge` runs the real binary: it runs `claude plugin validate` and
  `claude plugin test` on the Claude Code mod in `mods/atc-bridge/`. Neither starts a session.
- When you test the lock that atc takes on Claude's config file for a clone-trust launch, test it
  against `proper-lockfile`, the lock library Claude Code bundles, as
  [`with-claude-config-lock.test.ts`](../../../packages/harnesses/claude/src/local-trust/with-claude-config-lock.test.ts)
  does.

## Lanes

Put a suite in a lane when it needs something outside the test process, such as a CLI on the machine
or a real `bun install`. The Needs column below gives what each lane needs. Each lane has a test
script of its own. The unit run, `bun run test`, leaves out every lane's files.

The unit run and the Codex and toolchain lanes run through
[`@zgeoff/rig`](https://github.com/zgeoff/tools/tree/main/packages/rig), the shared test runner,
inside the test home. [`rig.config.ts`](../../../rig.config.ts) declares those two lanes and their
limits. The e2e lane runs through `bun test` in its own `test:e2e` script, which sets its 15 s limit
with `--timeout`.

| Lane      | Suite                                       | Script                   | Needs                                                                         | Limit per test |
| --------- | ------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- | -------------- |
| e2e       | a file in `e2e/`                            | `bun run test:e2e`       | the `atc` CLI, the daemon or `atc-gateway`, started as a process              | 15 s           |
| codex     | `<module>.codex.test.ts`, beside the module | `bun run test:codex`     | the Codex CLI on the machine                                                  | 5 s            |
| toolchain | `<module>.toolchain.test.ts`, beside it     | `bun run test:toolchain` | a real `bun install`, type check and test run of a workspace in a temp folder | 15 s           |

- Never add a skip guard to a lane suite. It runs only in its lane, and fails when what the lane
  needs is missing.
- CI installs the Codex CLI at the version that `CODEX_VERSION` in
  [`checks.yml`](../../../.github/workflows/checks.yml) pins.
- Never give a lane test a timeout of its own. Each lane's runner sets the limit in the table.
- Run one e2e suite with `bun run test:e2e e2e/<file>.test.ts`. Pass only e2e files and the options
  that [`with-e2e-paths.sh`](../../../scripts/with-e2e-paths.sh) lists. The script refuses any other
  file. A unit test run there would get the e2e lane's 15 s limit in place of the unit run's 5 s.
- Write each `e2e/` suite to pass in any order. CI's test job runs every suite that has no `daemon-`
  or `gateway-` prefix from source, in random order.

To add a lane named `<lane>`, for files that end in `.<lane>.test.ts`:

1. Declare `<lane>` in `rig.config.ts` with its limit. The `zgeoff/max-test-timeout` and
   `zgeoff/test-beside-module` lint rules read the lanes there, and the unit run and the pre-push
   hook leave the lane's files out. Expect: `bun run test` runs none of them.
2. Add a `test:<lane>` script to [`package.json`](../../../package.json), modelled on `test:codex`.
3. Add a step that runs the script to the `test` job in `checks.yml`, after a step that installs and
   pins what the lane needs, as the Codex lane does.
4. Add the lane's row to the table in this section.

## Worker count

- Set `TEST_WORKERS` to choose how many workers the unit run and `test:e2e` use. Without it, each
  picks up to 4, and 1 on a host with less than 4 GiB of memory. The Codex and toolchain lanes run
  one file at a time.
- To change how `test:e2e` picks its count, change
  [`read-worker-count.ts`](../../../scripts/read-worker-count.ts) in the zgeoff/tools repo. A sync
  job there copies the file into atc, and the next copy replaces a change made here.

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
