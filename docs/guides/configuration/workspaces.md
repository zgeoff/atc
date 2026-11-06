# Sources and workspaces

Every session runs in a working directory. The spawn picker offers the workspaces that the
configured sources list, and a spawn from a git repository fetches it over an allowed git transport
and clones it into a new directory on its target. The [targets guide](./targets.md) covers the
targets themselves.

## Sources

The top-level `sources` map holds exactly the workspace sources the daemon offers, keyed by source
id, in the picker's order. A source you leave out does not exist, so you opt in to a source by
listing it and opt out by deleting it. A first run writes the three built-in sources,
`{ "dirs": { "roots": [] }, "github": {}, "git": {} }`. This map adds a second GitHub source for one
organization:

```json
{
  "sources": {
    "dirs": { "roots": ["~/projects", "~/work"] },
    "github": {},
    "acme": { "kind": "github", "owner": "acme-tools" },
    "git": {}
  }
}
```

| Field   | Kinds    | Default                                | Meaning                                                                                                                      |
| ------- | -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `kind`  | all      | the id, for `dirs`, `github` and `git` | The source: `dirs`, `github` or `git`. An entry with any other id needs it.                                                  |
| `roots` | `dirs`   | `[]`                                   | Directories whose children and `.worktrees/*` entries the list offers. The [directories](#directories) section covers it.    |
| `owner` | `github` | `null`                                 | The account or organization a listing without a scope lists. `null` lists every repository the signed-in account can access. |
| `bin`   | `github` | `"gh"`                                 | The `gh` executable: a name looked up on `PATH`, or a path.                                                                  |

The entry's id is the source's id everywhere: in the sources the daemon lists to a client, in each
request to one source, and in the picker. An id is 1 to 64 characters, and atc refuses `__proto__`
and an id of digits alone, because JavaScript moves an integer key to the front of an object.

atc parses each entry strictly, and leaves out an entry it cannot use:

- an unknown field, a field of the wrong type, or a field of another kind;
- a `kind` that contradicts a built-in id, such as `"github": { "kind": "git" }`;
- a second entry of kind `dirs`, because an adopt opens on the one directory source.

The daemon prints one line for each problem when it starts, such as
`sources.acme: owner is not a GitHub account or organization`, and loads the other entries. A
`sources` value that is not an object leaves no source and prints
`sources must be an object of source entries`. The daemon also leaves out a `github` entry whose
`gh` it cannot find, and prints `sources.github: gh is not on the daemon's PATH; left out`.

`"sources": {}` offers no source, and the picker refuses a spawn with
`the daemon offers no sources · set sources · esc cancel`. An adopt needs a `dirs` source, and the
picker refuses one without it the same way.

### The old source keys

A config without `sources` builds the same sources from the old keys: `workspaces.sources` lists the
source ids in picker order, and `null` offers `dirs`, `github` and `git`. `dirs.roots` becomes the
`dirs` entry's `roots`, and `workspaces.githubOwner` becomes the `github` entry's `owner`. The
daemon prints a deprecation that names the old keys the file sets, such as
`config.json uses dirs and workspaces.sources; run 'atc config migrate' to move them into sources`.

`atc config migrate` writes `sources` in the place of the first old key, removes the old keys, and
keeps in each entry only the fields that differ from a default. The
[agents guide](./agents.md#migrating-from-the-old-keys) covers the command's flags and backup.

A file that sets `sources` and any old key is unusable, because no rule picks between the two
values: every spawn fails with a problem such as
`dirs cannot be set together with sources; move it into sources and remove it`. `"sources": {}`
beside an old key counts as setting `sources`. `atc config migrate` refuses that file with the same
message, exits 1, and writes nothing, so you move the old keys into `sources` by hand.

## Directories

The directory picker behind `n` lists the directory you ran `atc` from, then what the daemon's
`dirs` source lists in a fixed order: atc's own spawn history (most recent first), then every
project under the source's `roots`, then zoxide's list when zoxide is installed. A path that no
longer exists is dropped, and a duplicate keeps its first position.

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

## Cleanup when you forget a session

A forget removes the session's state folder, `~/.local/state/atc/sessions/<session id>/`, which
holds atc's own files for the session, such as its scratch folder. It also removes the workspace
that atc cloned for the session, once the work there is pushed. A kill of a session that has already
exited forgets it the same way. A directory you made yourself is never removed, even when a session
ran in it.

atc keeps a workspace that holds work found nowhere else: an uncommitted or untracked file, a stash,
or a commit that no remote-tracking branch holds, a commit on a detached HEAD, a local tag or a
notes ref included. It also keeps one that has a linked worktree, a submodule, or a file marked
`--assume-unchanged` or `--skip-worktree`, one that another session runs in, or one whose host does
not answer. It waits for the session's process to exit first, and keeps both folders when it cannot
see the process end, such as after a headless turn, even one you stopped. A folder that atc built
but that is now a symlink stays too. The forget still succeeds, and its answer and the daemon log
say why atc kept it, such as `2 unpushed commits on fix-x`. A file that git ignores, such as
`node_modules/`, never keeps a workspace.

```json
{
  "workspaces": { "cleanup": { "enabled": true, "check": "unpushed" } }
}
```

- `enabled` defaults to `true`. `false` removes neither the workspace nor the state folder.
- `check` defaults to `"unpushed"`, which removes a workspace only when nothing in it is unpushed.
  `"none"` removes every workspace atc cloned, whatever it holds, and the daemon logs what it held.
  It still keeps a workspace that another session runs in.

A `cleanup` that is not an object, or an `enabled` other than `true` or `false`, is a config error:
the daemon prints it at startup and removes nothing on a forget until you fix it. Any other `check`
value is a config error too, and the daemon uses `"unpushed"` until you fix it.

[Workspaces](../../architecture/execution/workspaces.md#cleanup-on-forget) gives the checks in full.
