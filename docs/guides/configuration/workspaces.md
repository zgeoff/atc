# Directories and workspaces

Every session runs in a working directory. The directory picker offers the directories you work in,
and a spawn from a git repository fetches it over an allowed git transport and clones it into a new
directory on its target. The [targets guide](./targets.md) covers the targets themselves.

## Directories

The directory picker behind `n` lists the directory you ran `atc` from, then what the daemon's
`dirs` source lists in a fixed order: atc's own spawn history (most recent first), then every
project under `dirs.roots`, then zoxide's list when zoxide is installed. A path that no longer
exists is dropped, and a duplicate keeps its first position.

`workspaces.sources` holds the ids of the sources the daemon offers, in picker order, and `null`
offers every source the daemon can run. When the daemon offers no source, the picker refuses the
spawn and names `workspaces.sources`. An adopt needs the `dirs` source, and the picker refuses one
without it the same way.

```json
{
  "dirs": { "roots": ["~/projects", "~/work"] }
}
```

Each root contributes its immediate child directories and each child's `.worktrees/*` entries, so
`~/projects/atc` and `~/projects/atc/.worktrees/fix-picker` both list for a root of `~/projects`.
Hidden directories are skipped. A root that does not exist contributes nothing.

Typed input that starts with `/`, `~`, `.`, or `..` completes against the filesystem instead of
filtering the list: `~/pro` lists the directories under your home that start with `pro`, and a
trailing slash lists every child. A relative path resolves against the directory you ran `atc` from.
Hidden directories complete only when the typed segment starts with a dot.

## Git transports

A spawn whose workspace is a git repository fetches it on the daemon's host.
`workspaces.gitTransports` holds the git transports that fetch may use, and defaults to
`["https", "ssh"]`; the scp-style `user@host:path` counts as `ssh`. A URL on any other transport
fails as `invalid_git_url` before git runs, and every git command the daemon runs is held to the
same list, so a host `insteadOf` rewrite, a checkout's origin, or a submodule cannot reach another
transport.

```json
{
  "workspaces": { "gitTransports": ["https", "ssh", "file"] }
}
```

The list accepts `https` and `ssh`, plus two opt-ins, `http` and `file`. This is trusted-operator
configuration, and it comes only from this file: no request, source, or environment variable widens
it. Each opt-in widens what the daemon fetches on behalf of any client that can spawn a session.
`http` sends repository contents and any credentials unencrypted. `file` lets a git source read any
repository on the daemon's host that the daemon's user can read. An empty list is valid and allows
no transport, so every git source fails.

Any other name is a config error, `git`, `ext`, `fd`, and remote-helper names among them, as is a
value that is not a list. The daemon prints the error at startup and runs no git until you fix it:
probing a repository, and spawning a workspace from a repository or from a checkout, fail as
`git_transports_invalid` with the same error. Sessions that need no git, such as one in a local
directory, start as usual.

A first run writes the default list into config.json. A config that lists the transports keeps its
list, so a later change to atc's default does not reach it.

## Workspace destinations

A spawn whose workspace is a git repository clones it into a new directory on its target. When the
spawn gives no directory, atc picks `<root>/<repo>-<ref>-<short sha>`, such as
`~/.local/share/atc/workspaces/app-main-c2e799e`. The spawn picker's confirm screen shows that path
and takes it on Enter, and an `atc_session_spawn` call without `cwd` gets it the same way. The short
sha is left out of the name when the spawn gives only a ref.

The root is `workspaces.targets.<target id>` when set, else `workspaces.root`, else
`~/.local/share/atc/workspaces`:

```json
{
  "workspaces": { "root": "~/workspaces", "targets": { "cloud": "/srv/work" } }
}
```

A root that starts with `~` resolves on the target. On the daemon's own machine `~` is the daemon
user's home. On a remote target, such as an imp, the daemon passes the path relative to the home and
the host resolves it, since only that host knows its home. Any other root must be an absolute path.

When the picked directory exists, or another session's workspace holds it, the daemon tries the same
path with `-2`, `-3`, and so on, up to `-100`. It claims each directory with `mkdir`, so repeated
and concurrent spawns of one repository land side by side and never write into a directory that
already exists. The session's working directory holds the path the workspace landed in, and the
session list shows it.

A destination you type replaces the picked one. It must be an absolute path on the target, and `~`
in it expands only on the daemon's own machine.
