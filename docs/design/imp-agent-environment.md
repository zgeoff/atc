# Imp agent environment

An agent that atc launches on a fresh imp starts signed in with Geoff's subscription, runs with
Geoff's Claude configuration, and has the MCP tools it needs, with nobody typing into the imp. Three
components split the work. The imp image holds binaries and toolchains only. impd holds every secret
and swaps it into the guest's HTTPS requests through the
[credential broker](https://github.com/zgeoff/imp/blob/main/docs/guides/connectors.md). atc binds
each session at spawn: it grants the secrets, sets placeholder variables, and ships the session's
configuration. A secret that the broker can carry never reaches the guest's disk, memory snapshots,
checkpoints, forks, or backups.

## Owners

Each layer has one owner, and each kind of state lives in exactly one layer.

| Layer           | Owner        | Holds                                                          | Changes when                           |
| --------------- | ------------ | -------------------------------------------------------------- | -------------------------------------- |
| Image           | zgeoff/cloud | binaries, toolchains, pinned versions                          | a tool version changes                 |
| Connector store | impd         | secret values, host rules, grants, token refresh               | a secret is added, rotated, or revoked |
| Session binding | atc at spawn | grants, placeholder variables, config bundle, MCP config, seed | every spawn                            |

atc owns all per-session setup, for sign-in, configuration, and tools alike. impd stays generic: atc
uses its `custom` connector kind for static credentials, and impd needs no Claude-specific code. The
image never holds configuration or login state.

**Why:** atc already ships per-session files into the guest (`src/agents/claude-adapter.ts`) and
binds gateway secrets through the broker (`src/daemon/runtime-auth-binder.ts`). The GitHub token for
imps takes the same route, so sign-in, configuration, and tools are one mechanism. Configuration
changes weekly, and an image rebuild is a release. The guest has no per-session bootstrap step: only
`services.d` runs at boot.

## Claude sign-in

Claude Code on an imp signs in with a `claude setup-token` token that impd holds and the broker
injects. The guest never holds the token.

`claude setup-token` prints a one-year OAuth token that bills against the Pro or Max subscription
and can only make model requests. The flow:

1. Geoff runs `claude setup-token` once on his PC and writes the token to the `cloud` 1Password
   vault.
2. The token goes into impd as a `custom` connector on `api.anthropic.com`, header `authorization`,
   scheme `bearer`.
3. The Claude adapter gains an auth selection, so the `claude` agent reports `brokerAuth: true` on
   an imp target. atc grants the connector to the session's imp and starts the harness with
   `require: ['broker']`.
4. The session's settings set `CLAUDE_CODE_OAUTH_TOKEN=imp-broker-placeholder`. The broker drops the
   placeholder header and sets the real token.

Claude Code 2.1.291 sends `CLAUDE_CODE_OAUTH_TOKEN` as `Authorization: Bearer <token>` with
`anthropic-beta: oauth-2025-04-20`, and to `api.anthropic.com` alone. It validates nothing locally:
the first rejection is the server's `401 OAuth access token is invalid`. The other hosts it reaches
carry no credential:

- `platform.claude.com` (`/v1/oauth/hello`, a reachability check)
- `downloads.claude.ai` (updates and the official plugin marketplace)
- `raw.githubusercontent.com` (the changelog)

An interactive start with no saved state shows the theme picker of first-run onboarding. A
`.claude.json` holding `hasCompletedOnboarding: true` and the workspace's trust skips onboarding and
reaches the prompt with no sign-in screen. The brokered gateway seeds that file in its own config
folder (`src/agents/gateway-adapter.ts`), and the Claude adapter reuses that code.

`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` both outrank `CLAUDE_CODE_OAUTH_TOKEN`. atc refuses a
subscription Claude spawn whose settings or environment set either one, so a paid API key never
stands in for the subscription.

### Renewal and revocation

- **Renew:** Geoff runs `claude setup-token` again before the year ends, updates the vault item, and
  runs `imp secret add --replace`.
- **Revoke on the imp side:** `imp revoke <imp> <secret>` ends one imp's access. Removing the secret
  ends every imp's access.
- **Revoke on the Anthropic side:** no documented command revokes a `setup-token` token.
- **Failure:** an expired or revoked token gives `401 OAuth token has expired` or
  `OAuth token revoked` inside the session, with no fallback. A missing grant refuses the spawn with
  `broker_not_ready`.

### Rejected options

- **Pass the token into the guest** as an environment variable or in the settings file. It works
  with no impd change, but the value lands in the guest's process memory, so it lands in every
  memory snapshot. In the settings file it lands on the disk too, so it lands in checkpoints, forks,
  templates, and restic backups.
- **Copy `~/.claude/.credentials.json`.** Its refresh token renews on use, and two machines that
  refresh one file race each other until one is signed out. The format is undocumented.
- **Use an Anthropic API key** through the `anthropic` connector kind. That bills to the API, not
  the subscription.

## Codex sign-in

Codex on an imp signs in with a ChatGPT sign-in that impd refreshes, through a refreshing OAuth
connector kind. The guest holds placeholders only. A paid API key is never the route.

A ChatGPT sign-in is `~/.codex/auth.json`, which holds an access token, an ID token, and a refresh
token. Codex refreshes the tokens about every 8 days and writes the new ones back. OpenAI's docs say
"do not share the same file across concurrent jobs or multiple machines", because a refresh on one
machine invalidates the others. A static `custom` connector cannot follow a token that rotates, so
impd gains a connector kind that can.

The refreshing OAuth connector holds a refresh token, a token URL, and a client ID. impd refreshes
the access token before it expires, stores each rotated refresh token, and sets the current access
token as a bearer header on the granted hosts. The kind is generic: an OAuth-only MCP server has the
same shape.

The flow:

1. Geoff runs `codex login` once on his PC with a dedicated `CODEX_HOME`, pipes the refresh token
   into `imp secret add --kind oauth`, and deletes that `CODEX_HOME`, so nothing else refreshes the
   token.
2. impd refreshes the token and injects the current access token.
3. atc grants the connector and ships a placeholder `auth.json` whose `last_refresh` lies far in the
   future, so the guest never refreshes.

Two facts gate the design: which hosts and headers carry the access token, and whether Codex accepts
a placeholder access token and what it needs from the ID token. A spike settles both. If the spike
fails, Codex stays off imps.

**Why impd, not atc:** atc holds no secret values, and its `authProfiles` only refer to impd
secrets. A refresher in atc would put a long-lived refresh token in atc's state, and it would stop
refreshing whenever Geoff's PC is off while imps keep running.

## Claude configuration

atc ships a curated, secret-free bundle from the host's rendered `~/.claude` into a per-session
Claude config folder at spawn. Claude Code reads the folder through `CLAUDE_CONFIG_DIR`, the same
way the brokered gateway does.

| Source                                                 | Shipped  | Rule                                             |
| ------------------------------------------------------ | -------- | ------------------------------------------------ |
| `CLAUDE.md`                                            | yes      | as rendered                                      |
| `settings.json`                                        | filtered | allow-listed keys only                           |
| `statusline.sh`                                        | yes      | `statusLine.command` rewritten to the guest path |
| `agents/`, `output-styles/`                            | yes      | as rendered                                      |
| `skills/`                                              | yes      | symlinks resolved into copies                    |
| `.credentials.json`, `.claude.json`, history, projects | no       | account state                                    |
| plugins                                                | no       | see [Plugins and mods](#plugins-and-mods)        |

The settings allow-list:

- `model`, `effortLevel`, `advisorModel`, `outputStyle`, `autoCompactWindow`
- `autoMode` and `permissions`, with `permissions.defaultMode: auto`
- `attribution`, `includeCoAuthoredBy`
- `statusLine`, with its command path rewritten
- `skipAutoPermissionPrompt`, `skipWorkflowUsageWarning`, so a fresh imp asks nothing
- `editorMode`, `tui`
- `env`, filtered by its own allow-list, which holds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`

atc never ships a key off the allow-list, so a key Geoff adds later stays on the host until someone
lists it, and an `env` entry that holds a secret never ships. The bundle's source is the rendered
files on the daemon's host, not the chezmoi source, because the chezmoi source decrypts `autoMode`
with an age key that must not reach a guest.

atc's statusline runs the user's statusline first and appends its own segment (`src/statusline.ts`).
In a guest it reads the user's statusline from `$CLAUDE_CONFIG_DIR/settings.json`. Geoff's
`statusline.sh` needs `bash`, `jq`, and `git`, which the image holds.

**Why a per-session folder:** sub-sessions share their parent's imp, and the per-session folder
keeps each session's history and resume state apart. A running session reads its bundle once at
start, so a configuration change reaches the next spawn.

### Merge with a repo's settings

The bundle is Claude Code's user scope, so the repo's `.claude/settings.json` and
`.claude/settings.local.json` rank above it, and Claude Code's own precedence settles conflicts.
atc's `--settings` file adds the reporting hooks, and hook entries merge across layers rather than
replace each other. `permissions.defaultMode: auto` takes effect at user scope, where the bundle
puts it: Claude Code ignores that value in project and local settings.

### Auto mode

Claude subscription sessions use Claude Code's built-in `auto` permission mode, which the bundle
delivers through `autoMode` and `permissions.defaultMode: auto`. atc starts a subscription Claude
session without `--permission-mode`, because that flag outranks the bundle's default mode. A
classifier reviews each action in place of a permission prompt.

Gateway sessions use the `auto-mode` mod, which judges each permission request with the Jev model,
because the built-in classifier runs on Anthropic models only. The gateway entry passes the mod with
`--plugin-dir`, and the mod calls the `auto-mode` CLI. On an imp:

- The image installs the `auto-mode` CLI and its `mods/auto-mode` folder at a pinned version and a
  fixed path.
- The gateway's imp launch passes the guest path to `--plugin-dir`, and the mod's `command` setting
  points at the guest CLI.
- The bundle ships `~/.config/auto-mode/config.json` without `apiKeyCommand`, whose host path reads
  a secret file.
- impd holds the Jev key as a connector, and the guest's `AUTO_MODE_JEV_LOCAL_KEY` holds the
  placeholder.

### Plugins and mods

Marketplace plugins stay off imps. atc never ships `enabledPlugins` or `extraKnownMarketplaces`, and
a plugin that earns a place on imps goes into the image at a pinned version, so a launch needs no
network install. A mod passed with `--plugin-dir` is not a marketplace plugin: atc ships
`atc-bridge` on every spawn, and the image holds the `auto-mode` mod.

## Secrets in the guest

A secret reaches a guest tool through a brokered connector whenever the tool sends it as a static
HTTPS header. The broker serves any guest process that honours `HTTPS_PROXY` and the broker CA,
which covers `curl`, `gh`, git, Node, Go, and Python.

| Credential shape                | Example                                                            | Route                      |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Static bearer or API-key header | Claude, GitHub, Linear, Cloudflare                                 | `custom` connector         |
| Rotating OAuth token            | Codex                                                              | refreshing OAuth connector |
| Signed request                  | Pulumi state on R2 (AWS SigV4)                                     | 1Password Connect          |
| Secret used locally             | Pulumi passphrase, SSH keys, database DSNs, a token in a URL query | 1Password Connect          |

A 1Password service account token never goes to a guest. It holds the key material that `op` uses to
decrypt vault data, so the broker cannot carry it, and in the guest it lands on disk and in
snapshots.

1Password Connect gives a guest the secrets that the broker cannot carry. A Connect server in the
cloud k3s cluster reads only the vaults granted to it. Connect authenticates with a plain bearer
token, so impd holds that token as a `custom` connector on the Connect host, and the guest holds
`OP_CONNECT_HOST` and a placeholder `OP_CONNECT_TOKEN`. `op read`, `op run`, `op inject`, and
`op item get --format json` work against Connect, so a launcher that runs `op read` works unchanged.
A value read through Connect lives in the memory of the guest process that read it, like any value a
tool needs in memory.

## MCP tools

MCP servers come from two levels:

- **User level:** atc ships an MCP config for each session. Its first set is Linear alone.
- **Project level:** a repo's own `.mcp.json` arrives with the clone. atc's per-session seed
  approves its servers for a trusted clone (`trustClonedWorkspace`), so an unattended session never
  waits on the approval prompt. An untrusted clone prompts.

| Server            | User-level set | Reason                                                                                    |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Linear            | yes            | delivery agents read and update issues                                                    |
| atc               | no             | the guest reaches the daemon through the session bridge only; `atc-bridge` gives `report` |
| GitHub            | no             | `gh` and git use the brokered GitHub token                                                |
| pixellab, blender | no             | local creative tools; blender runs on Windows                                             |

impd holds a Linear personal API key as a `custom` connector on `mcp.linear.app`, header
`authorization`, scheme `bearer`, and the session's MCP config sends
`Authorization: Bearer imp-broker-placeholder`. Linear's OAuth sign-in needs a browser on each imp,
so the API key replaces it. The key acts as Geoff, the same principal as the GitHub token, with
write access, because delivery work updates issues. A `viewer` query proves the principal without
changing anything.

The Linear endpoint speaks Streamable HTTP. The broker's TLS terminator serves HTTP/1.1 only and
refuses WebSocket upgrades. Whether a long-lived server-sent event stream survives the terminator is
untested.

A project's servers take their credentials by the shapes in
[Secrets in the guest](#secrets-in-the-guest). The vers repo shows each case:

- `bugsink`, `tinybird`, `umami`, and `postgres` read secrets with `op read` and need Connect.
- `neon` and `axiom` sign in with OAuth and need a header-key variant.
- `serena` and `chrome-devtools` reach processes on Geoff's PC and need guest-side processes.

## Image

imp publishes `imp-base` as its only image. zgeoff/cloud holds Geoff's imp image definition, built
`FROM imp-base` with `imp image build` on the imp host, and the `cloud` target runs it.

The image holds, each at a pinned version:

| Item                                  | Used by                                        |
| ------------------------------------- | ---------------------------------------------- |
| `claude`, with `DISABLE_UPDATES=1`    | the harness, which downloads updates otherwise |
| `codex`                               | the Codex harness                              |
| `git`, `gh`, `jq`, `bash`             | git work, PRs, Geoff's statusline              |
| Node 24, `bun`, `build-essential`, Go | atc's repos, Node MCP launchers, native builds |
| Python 3, `uv`/`uvx`                  | Python MCP servers such as serena              |
| `op`                                  | 1Password Connect                              |
| `auto-mode` CLI and its mod folder    | gateway sessions                               |

The image holds no configuration, no login state, and no secret. Headless Chrome stays out until a
project needs it on imps.

At launch, atc sets up everything that varies by session or by secret: the grants, the placeholder
variables, the config bundle, the MCP config, and the onboarding, trust, and MCP-approval seed.

## Open questions

- How to revoke a `setup-token` token on the Anthropic side.
- Whether a long-lived Streamable HTTP stream survives the broker's HTTP/1.1 terminator.
- Whether running sessions take a replaced secret without a restart.
