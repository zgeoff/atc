---
name: verify
description:
  'Uses atc the way a user would with `bun verify`: drives the real TUI, daemon, `atc events`, MCP
  servers and gateway against a stand-in claude in a temp home, and records the verdict that a
  feature works. Load it before you check a change in the running app, run the journey of a feature,
  read the deployed gateway on prod, or put the verdicts in a PR.'
metadata:
  wringer-template: 'sha256:3a8295eb8ec4'
  wringer-command: bun verify
---

# Verify atc

Use `bun verify` to start the app, use each feature your change touches the way a user would, and
record a verdict that it works. Put the report in the PR with `bun verify publish`, and hand back
the PR link and each feature you could not verify. Leave `bun verify gate` to CI: it reads the
report from the PR description, and fails a PR that changes a feature with no verdict there.

The mistakes that cost the most time:

- **Using the app before `doctor` passes.** `bun verify doctor` checks that the app answers and that
  each driver works. A driver is a package, such as `@wringer/http`, that adds a group of commands,
  such as `bun verify http request`. Until `doctor` passes after `bun verify up` or
  `bun verify attach`, any command that touches the app fails with exit code 3.
- **Editing the app's code while `up` runs it.** The next command that touches the app fails with
  `doctor-required`. Run `bun verify up --restart` and `bun verify doctor`, then the journey again.
- **Running `done` before you check the end state.** `done` checks only that one command of the
  journey succeeded.

## Key rules

- [Check a change](#check-a-change): for each changed feature, run its journey, check the end state,
  then `done`.
- [Read the envelope](#read-the-envelope): branch on the exit code and `error.code`, never on the
  message, which can change in any release.
- [Targets](#targets): check a change on a launch target, a target whose app `bun verify up` starts
  from your worktree.
- [Commands](#commands): read `--help` before you guess a flag.
- [Edit the skill and the registry](#edit-the-skill-and-the-registry): map each new file in the
  registry, read the reference before you edit the skill, and run `lint`.

## References

- [Exit codes](references/exit-codes.md): when a command fails, what to do for its exit code and
  `error.code`.
- [Edit the skill](references/edit-the-skill.md): before you edit this skill or a feature file.

Read a feature's file before you run its journey.

<!-- wringer:features -->

| Feature             | Summary                                                                                 | File                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| spawn-session       | Spawn a session from the TUI picker, and see it start                                   | [references/feature-spawn-session.md](references/feature-spawn-session.md)             |
| session-list-leader | Open the session list with the leader key, ack a session, and filter the list           | [references/feature-session-list-leader.md](references/feature-session-list-leader.md) |
| kill-forget         | Kill a session from the session list, then forget it                                    | [references/feature-kill-forget.md](references/feature-kill-forget.md)                 |
| events-stream       | Follow the fleet with `atc events` while a session starts and stops                     | [references/feature-events-stream.md](references/feature-events-stream.md)             |
| mcp-fleet-tools     | Spawn, type into, read and stop a session with the tools of `atc mcp`                   | [references/feature-mcp-fleet-tools.md](references/feature-mcp-fleet-tools.md)         |
| session-messages    | Send a session a message with `atc mcp`, see it reach the session, and read it          | [references/feature-session-messages.md](references/feature-session-messages.md)       |
| remote-mcp-http     | Sign in to `atc mcp --http` as a service client, and list the sessions                  | [references/feature-remote-mcp-http.md](references/feature-remote-mcp-http.md)         |
| gateway-routing     | Call a tool through atc-gateway, and see the daemon refuse a gateway with a wrong token | [references/feature-gateway-routing.md](references/feature-gateway-routing.md)         |

<!-- /wringer:features -->

## Check a change

1. Run `bun verify report`. In `data.report.features`, a feature shows `changed: true` when a file
   that matches its `paths` in the [registry](#edit-the-skill-and-the-registry) differs from the
   default branch, committed or not.
2. Pick the target your task names. When it names none, take the first launch target in the
   [Targets](#targets) table. Run the commands in its row. `up` or `attach` starts a run, which
   lasts until `down` or `detach`. Expect from `up` or `attach`: `ok: true`, and the app's endpoints
   in `data.endpoints`.
3. Run `bun verify doctor`. Expect: `data.passed: true`. When a check fails, fix its cause, and run
   `doctor` again.
4. Run the journey from the feature's file in [References](#references). Its first line,
   `use --feature`, records each later command under that feature, and leaves the target as it is.
   Expect: each command exits 0. When one fails, do what its row in
   [Exit codes](references/exit-codes.md) says.
5. Compare the app with the feature's end state:
   - When it matches, and no command failed with `read-only`, go on to step 6.
   - When your change broke the feature, fix the app's code. Then run `bun verify up --restart`,
     `bun verify doctor` and the journey again.
   - When your change means to change the end state, fix the feature's file, and run
     `bun verify lint`. Then run the journey again.
   - In any other case, such as a `read-only` failure or a bug your change did not cause, skip
     `done` for this feature. List it in your reply with the end state you expected and the `data`
     you got.
6. Finish each edit to a file that matches the feature's `paths` before you run `done`. An edit
   after `done` makes the feature's verdict `stale`. A commit alone leaves the verdict as it was.
   Run `bun verify done` to record a verdict for the feature that `use --feature` set. Expect:
   `ok: true`. It fails with `check-failed` until a journey command succeeds after `doctor`.
7. Repeat steps 4 to 6 for each feature with `changed: true`, and for each feature your task names,
   in the order of the table in [References](#references). When the [Targets](#targets) section says
   to run a feature's journey last, run it after every other journey.
8. Run `bun verify report --human` to read the report. Expect: `verified` on each changed feature
   you did not skip in step 5. Repeat steps 4 to 6 for each `stale` feature.
9. Push the branch, and open a PR for it when none is open. Without an open PR, `publish` fails and
   writes nothing. Run `bun verify publish`, even when you skipped a feature. To write to a PR other
   than the branch's own, add `--pr <number>`. Expect: `ok: true`, and `data.action` of `created`,
   `replaced` or `unchanged`. It writes the report into the PR's description, the only report the
   gate reads.
10. End the run: `bun verify down` after `up`, or `bun verify detach` after `attach`.

## Read the envelope

Each command prints one JSON envelope as its last line, or text with `--human`. A streaming command,
such as `doctor`, prints JSON event lines before the envelope. Read these fields:

- `ok`, then `data` on success, or `error.code`, `error.message` and `error.hint` on failure;
- `evidence`: the files the command kept, under `.wringer/`;
- `truncatedPath`: the file that holds `data` when it was too large to print.

When a command fails, find its exit code and `error.code` in [Exit codes](references/exit-codes.md),
and do what that row says.

## Targets

Start a launch target's app with `bun verify up`, and stop it with `bun verify down`. Connect to an
attach target, a target whose app runs apart from `bun verify`, with `bun verify attach`.
`bun verify detach` leaves it running. Your edits never reach an attach target's app, so check a
change on a launch target.

Run `bun verify use --target <target>` to point every later command at a target. `use` saves the
choice in this worktree's `.wringer/`, for every shell and session. `--target` on one command points
that command alone. A command with neither runs on the registry's first target, so run `use` first.

<!-- repo: targets -->

| Target  | Start with                                                                        | Access     |
| ------- | --------------------------------------------------------------------------------- | ---------- |
| `local` | `bun verify use --target local`, then `bun verify up`                             | read-write |
| `prod`  | [On prod](references/feature-gateway-routing.md#on-prod), from step 1; no verdict | read-only  |

<!-- /repo -->

## Commands

Run `bun verify --help` for the list, with each command marked `[read]` or `[write]`. A read-only
target refuses each `[write]` command except `publish`, which writes no app data. `up` and `down`
are `[read]`, but start and stop the app. Run `bun verify <command> --help` for a command's flags.
The top-level list shows only the name of a group, such as `action`: run `bun verify <group> --help`
for its commands.

- Write a negative number with `=`, as in `--offset=-5`.
- Pass an object as JSON text, as in `--filter '{"shelf":"top"}'`.

<!-- repo: commands -->

Before you run or write a journey, read [Journey commands](references/journey-commands.md): the key,
session-name, `db` and `mcp --server` rules that `--help` leaves out.

<!-- /repo -->

## Edit the skill and the registry

<!-- repo: registry -->

The registry, [`create-verify-registry.ts`](../../../scripts/verify/create-verify-registry.ts),
declares the targets, commands and features, and takes each feature's `paths` and the `.ignore` list
from [`feature-paths.ts`](../../../scripts/verify/feature-paths.ts). Add a new file's glob to each
feature whose journey runs it. Ignore it only when atc never reads it at run time: an ignore glob
beats a feature's glob.

<!-- /repo -->

In the registry, map each file your change adds: add a glob that matches it to a feature's `paths`,
to `.shared()` or to `.ignore()`. The gate fails on a changed file that no glob matches. Add a file
that the running app never reads, such as a test, to `.ignore()`. `bun verify features` lists the
globs.

When a change to a feature breaks its journey, fix the journey in the same PR. Before you edit this
skill or a feature file, read [Edit the skill](references/edit-the-skill.md). After you change this
skill, a feature file or the registry, run `bun verify lint`, and fix each failure it reports.

**Reply:** the PR link that `bun verify publish` returned in `data.pr.url`, and each feature you
could not verify, with the command that failed and its `error.code`, or the end state you expected
and the `data` you got.
