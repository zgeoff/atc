# Targets

A target is a named place sessions run, served by an execution provider. With no `targets` key, atc
has one target, `local`, which runs each session on the daemon's own machine. Set `targets` to name
your own:

```json
{
  "targets": {
    "local": { "provider": "local-pty" },
    "box": { "provider": "imp", "url": "http://impd.tail:7070", "tokenEnv": "IMP_TOKEN" }
  },
  "defaultTarget": "local"
}
```

- `provider` selects the provider kind: `local-pty` or `imp`. Every other key in the entry is an
  option for that provider.
- A target whose provider kind this atc does not have still lists, as unavailable, and a spawn to it
  fails with `target_unavailable`.
- A `targets` map without `local` turns local sessions off: a spawn to `local` fails with
  `unknown_target`.
- A spawn without a target runs on `defaultTarget`. Without `defaultTarget`, it runs on `local` when
  the map holds it, and fails with `target_config_invalid` otherwise.

The [principals guide](./principals.md) covers which targets a remote client may use, and the
[workspaces guide](./workspaces.md#workspace-destinations) covers where a workspace lands on a
target.

atc never runs a session on a target other than the one it was sent to. A spawn to an unknown or
unavailable target fails, and a restore lists a session whose target is gone as exited, with
`no target '<target_id>'` as its last message. Revive it after you add the target back.

A session stays bound to its target's provider and connection options. On an imp target, you can
change `image`, `memoryMib`, `guestATC`, or `rebindChangedAuth` without refusing existing sessions;
new imps use the configured image and memory. Changes to the impd URL, token source, imp prefix,
guest directory, or other options refuse input, resume, and revive with `target_changed` for a
versioned binding. Restore the target's earlier config to use those sessions again. Never put a
credential value in a target's options; name an environment variable or a file that holds it
instead.

During fleet restore, atc checks a session with an unversioned imp identity against impd with the
current credentials. It accepts the connection identity only when the existing imp is present and
the credentials permit execution on it. A missing or unreachable imp stays refused; this check
creates no imp. An unconfirmed binding lists as `target '<target_id>' binding unverified`; check
impd access and retry fleet restore. The
[protocol](../../architecture/execution/targets.md#the-one-check) defines the identity format.

## Clone trust

Claude asks a person to trust a workspace folder before its first session there, and an agent caller
cannot answer that prompt. To accept trust for one launch, pass `trustClonedWorkspace: true` with a
`workspace` source to `session.spawn` or `atc_session_spawn`. atc accepts trust only after it
verifies the clone, and only for the clone's resolved root, so a sibling or parent folder still
asks. Trust allows Claude to load the repository's configuration and helpers, so use the option only
for repositories you trust. It changes no tool permission mode.

- On a `local-pty` target, the launch must use stock Claude. atc adds one entry for the clone root
  to your own Claude config (`~/.claude.json`, or `.claude.json` in `$CLAUDE_CONFIG_DIR`), under the
  lock Claude itself writes that file under, and leaves every other entry as it is. A launch that
  fails before Claude starts takes the entry back. The entry holds folder trust alone, so Claude
  still asks you to approve the MCP servers in the clone's `.mcp.json`.
- On an imp target, the launch must use a brokered Claude gateway or stock Claude with `auth`; see
  [brokered credentials](./brokered-credentials.md). atc seeds the trust in the session's own guest
  config, where it also approves every MCP server in the clone's `.mcp.json`, so the session starts
  those servers without asking. Claude Code moves that approval into the clone's
  `.claude/settings.local.json` on its first start. A launch without trust asks a person to approve
  the servers.
- On an imp target, a Codex entry with `auth` takes trust too. atc adds a `projects` entry for the
  clone root to the session's own Codex config; see
  [Codex subscription on imps](./codex-subscription.md).

atc refuses trust for any other agent or target, and for a launch without a workspace source.

On an imp target, a launch that signs in through the broker reads the clone's own Claude settings
before Claude starts, and fails with `auth_target_unsupported` when they would override that
sign-in; see [Claude subscription on imps](./claude-subscription.md). A brokered gateway gets the
same check.

Set `targets.<target_id>.trustClonedWorkspace` to a boolean to give that target a default. An
explicit `trustClonedWorkspace: true` or `false` on the launch overrides it; omitting both keeps
trust off. An inherited `true` has the same restrictions as an explicit `true`, so an ordinary
folder launch on that target must pass `false`. Changing this target option changes its identity, as
other target options do; existing sessions remain bound to the previous target configuration.

## imp targets

An `imp` target runs each top-level session in an imp of its own, a VM that impd hosts, and keeps
each sub-session in its parent's imp. A kill of the top-level session puts its imp to sleep, and
`session.forget` destroys it. The
[daemon architecture](../../architecture/execution/imp-provider.md) covers the lifecycle.

An imp target needs impd 2.2.0 or later, the first release that reports every capability atc uses.
atc checks impd's version before it readies an imp, and refuses an older impd, or one whose version
it cannot read, with `host_unavailable` and the problem `impd_outdated`. Upgrade impd to clear it.

atc puts its files in an `atc` folder inside the guest scratch folder that impd declares. impd
declares that folder from 2.6.0 on. For an older impd, set `guestDir`, or atc refuses the imp with
the same `impd_outdated` problem.

The target's options:

| Key                    | Default  | What it does                                                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `url`                  | required | Where impd listens. Without it the target lists as unavailable.                                       |
| `impPrefix`            | `atc-`   | The start of every imp name the target builds.                                                        |
| `tokenEnv`             | unset    | The environment variable of the daemon that holds the impd token.                                     |
| `tokenFile`            | unset    | The file that holds the impd token.                                                                   |
| `image`                | impd's   | The image a new imp boots.                                                                            |
| `memoryMib`            | impd's   | The memory a new imp gets.                                                                            |
| `guestDir`             | impd's   | The folder inside each imp that atc's files go under.                                                 |
| `guestATC`             | unset    | An atc binary installed in the image, which hooks run when it prints the daemon's version.            |
| `rebindChangedAuth`    | `false`  | Whether a revive or restore rebinds a host whose agent's auth profiles changed, instead of refusing.  |
| `dropSysAdmin`         | `false`  | Whether each harness starts without `CAP_SYS_ADMIN`, so root in it cannot remount the session record. |
| `trustClonedWorkspace` | `false`  | Default for clone trust; an explicit launch value takes precedence. See [clone trust](#clone-trust).  |

A workspace on an imp gets the daemon host's git `user.name` and `user.email` in its own
`.git/config`, since the image holds no git identity. A host that has no value for both sets none.

Set at most one of `tokenEnv` and `tokenFile`. A target that sets both is a config error, and each
spawn on it fails with `target_config_invalid`. A target with neither calls impd with no token.

A target that sets `tokenEnv` to a variable that is unset or empty when the daemon starts is a
config error. The daemon prints the variable's name at startup, never a value, lists the error in
`targetErrors`, and refuses each spawn on the target until the variable is set and the daemon
restarts.

`tokenFile` keeps the token out of the daemon's environment, so a systemd unit can pass it as a
credential:

```ini
[Service]
LoadCredential=imp-token:/etc/atc/imp-token
```

```json
{
  "provider": "imp",
  "url": "http://impd.tail:7070",
  "tokenFile": "/run/credentials/atc-daemon.service/imp-token"
}
```

The daemon reads the file at startup and again before each call and connection to impd, dropping one
trailing newline. A file that is missing, unreadable, or empty at startup is a config error the
daemon handles like an unset `tokenEnv` variable, printing the path and never the content. Rewrite
the file to rotate the token: the next call and connection to impd use the new one, with no restart.
systemd mounts `/run/credentials` read-only, so to rotate a credential it passes, change the source
file and restart the unit. A file that turns empty or unreadable while the daemon runs fails each
call and connection to impd as unauthorized until it holds a token again, and a spawn in that time
fails with `host_unavailable`.

Each imp name is `impPrefix` followed by the first 20 letters and digits of the id of the session
that owns the imp. Give atc a namespace of its own on a shared impd by setting `impPrefix`, such as
`harness-`, and scope the impd token's imp patterns to it (`harness-*`). The prefix is a lowercase
letter followed by up to 10 lowercase letters, digits or hyphens, so every name it builds is one
impd accepts. Any other value is a config error the daemon handles like an unset `tokenEnv`
variable.

A Claude session on an imp target reports through an atc inside the imp. With `guestATC` set, the
daemon uses the image's atc when it prints the daemon's version, and otherwise a compiled atc daemon
on Linux copies itself in, so a new atc release works on imps before you rebuild the image. A daemon
run from source has no binary to copy: it refuses the spawn when `guestATC` is unset, missing, or
prints another version. The [imp provider](../../architecture/execution/imp-provider.md) covers how
the daemon readies that atc.

A target config that is set but wrong fails closed. atc keeps running, the targets it can read keep
working, and every spawn that resolves through the problem fails with `target_config_invalid`, whose
message holds the problem:

- A `targets` that is not an object, or an empty map, leaves no target usable, `local` included.
- An entry that is not an object holding a non-empty string `provider` leaves that target unusable.
- A `defaultTarget` that matches no well-formed target leaves no default, so a spawn without a
  target fails.

A `config.json` that exists but that atc cannot use fails closed for every target, `local` included.
Invalid JSON, or a root that is not an object, is `config_malformed`. A read that fails for any
reason but a missing file, such as a directory at the path or a file you cannot read, is
`config_unreadable`. atc then has no targets and no default, and every spawn, revive, and headless
turn fails with `target_config_invalid` until you fix the file and restart the daemon. Listing and
reading sessions keep working. Only a missing file means the defaults, and atc writes them out on
its first run.

The daemon prints each problem to stderr when it starts, and `agents.list` returns them as
`targetErrors`. A file problem there has `scope` `config`, with `problem`, `path`, and `detail`. A
problem or detail holds no value from the file beyond a target's name, so a mistyped field reports
its kind, never its content. To find the line that breaks invalid JSON, run the file through a
validator such as `jq . ~/.config/atc/config.json`.
