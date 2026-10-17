# Claude subscription on imps

`auth` on a stock Claude entry, one without a `baseURL`, signs it in on an imp target with a
subscription token that impd holds, so the token never enters the imp. On the local target, Claude
keeps the sign-in of your own Claude config. The
[brokered credentials guide](./brokered-credentials.md) covers the profiles `auth` selects, and the
[subscription tools guide](./subscription-tools.md) covers MCP servers and API keys for the
session's tools.

1. Run `claude setup-token` on your machine. It prints an OAuth token that bills against your Pro or
   Max subscription and lasts one year.
2. Add the token to impd as a `custom` secret named `claude-setup-token` on the host
   `api.anthropic.com`, with a bearer `authorization` header. impz's
   [credential connectors guide](https://github.com/zgeoff/impz/blob/main/docs/guides/connectors.md#secrets-and-grants)
   gives the command.
3. List the secret in the `--grantable` secrets of the target's impd token when you make the token.
4. Add a profile for the secret and select it in the entry's `auth`, beside any other profile the
   session needs:

   ```json
   {
     "authProfiles": {
       "claude": {
         "secret": "claude-setup-token",
         "host": "api.anthropic.com",
         "header": "authorization",
         "scheme": "bearer"
       },
       "github": { "secret": "github-imp-agents", "kind": "github" }
     },
     "agents": { "claude": { "auth": { "profiles": ["claude", "github"] } } }
   }
   ```

`auth` on a stock entry holds `profiles`, the optional
[`mcpServers`](./subscription-tools.md#mcp-servers-on-imps), and the optional
[`placeholderEnv`](./subscription-tools.md#api-keys-for-a-sessions-own-tools), which binds a
variable to a profile that is not Anthropic's. atc fixes the endpoint, `https://api.anthropic.com`,
and the subscription placeholder, `CLAUDE_CODE_OAUTH_TOKEN=imp-broker-placeholder`. Claude Code
sends that variable as a bearer `authorization` header to `api.anthropic.com` and to no other host,
and impd swaps the placeholder for the token there. atc leaves the entry out and prints the reason
when the daemon starts if a selected profile does not resolve, or if no profile sets a bearer
`authorization` header for `api.anthropic.com`.

On an imp target, each session gets the same guest folder a brokered gateway gets: a settings file
for its binding revision that holds the placeholder, and a Claude config folder of its own that atc
seeds with first-run onboarding state and the outside-read offer mark, plus folder trust with
[clone trust](./targets.md#clone-trust). atc fills that folder with the
[Claude config bundle](#claude-config-bundle) and a `.credentials.json` that holds the placeholder
as its access token. Claude Code removes the placeholder variable from the environment of every tool
it runs, so a `claude -p` that a tool starts, with any setting sources, signs in through the broker
from that file. The CLI starts without `--permission-mode`, and atc drops one from the entry's
`args`, so the auto mode the bundle sets applies. A headless turn is refused there, as on every imp
session.

Three kinds of variable keep Claude Code from sending the subscription token to the Anthropic API:
`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` outrank it, `ANTHROPIC_BASE_URL` moves the endpoint,
and the `CLAUDE_CODE_USE_*` provider selectors (`BEDROCK`, `VERTEX`, `FOUNDRY`, `MANTLE`,
`ANTHROPIC_AWS`, `ANTHROPIC_GOOGLE_CLOUD`, and `GATEWAY`) select another provider. atc keeps each of
them away from a subscription session:

- The entry is refused when its `env` or `settings.env` sets any of them, `CLAUDE_CODE_OAUTH_TOKEN`,
  or a proxy or CA variable, and when its `settings` set `apiKeyHelper`. The error reads
  `agents.<id>: env must not set <variable>, which would override or route around the subscription sign-in`.
- A spawn fails with `auth_target_unsupported` when an inline `--settings` in the entry's `args`
  sets any of them, `CLAUDE_CODE_OAUTH_TOKEN`, or a proxy or CA variable.
- The session exits with status 78 before Claude starts when the imp's environment sets any of them,
  and its screen shows which one.
- A spawn, resume, restore, or adopt fails with `auth_target_unsupported` before Claude starts when
  a project settings file sets `apiKeyHelper`, or its `env` sets any of them,
  `CLAUDE_CODE_OAUTH_TOKEN`, or a proxy or CA variable. atc reads `.claude/settings.json` and
  `.claude/settings.local.json` in the folder Claude starts in, as the imp resolves it, and
  `.claude/settings.local.json` in every folder above it and in a git worktree's main checkout,
  since Claude reads that file at the repository root. Claude applies those files once the folder is
  trusted, and a person can accept that trust inside the session, so atc reads them whether or not
  the launch passes `trustClonedWorkspace`. A file that is not a JSON object, not a regular file,
  larger than 1 MiB, or unreadable fails the launch too. A spawn that cloned the folder removes the
  clone. The error's `data` holds the file's path and the setting, never its value.

The same `env` and `settings` load on a stock entry without `auth`, where nothing is bound.

A revoked grant or an expired token gives `API Error: 401` inside the session, and Claude never
falls back to another sign-in. To renew the token, run `claude setup-token` again and replace the
secret's value with the new token, as the connectors guide's
[rotate or rebind](https://github.com/zgeoff/impz/blob/main/docs/guides/connectors.md#rotate-or-rebind)
section describes.

## Claude config bundle

Each launch of a stock Claude session with `auth` on an imp copies an allow-listed part of the
daemon host's Claude config folder (`$CLAUDE_CONFIG_DIR`, or `~/.claude`) into the session's own
config folder, where Claude Code reads it as user settings:

- `CLAUDE.md` and `statusline.sh`
- every file under `agents/` and `output-styles/`
- each folder under `skills/` that holds a `SKILL.md`, with symlinks copied as the files they point
  at
- `settings.json`, cut to the keys below

A file its owner may execute stays executable in the guest. A symlink ships only when its target
could ship by its own path, so a link to `.credentials.json` or to the unfiltered `settings.json`
never does. The bundle leaves out every other entry, so `.credentials.json`, `.claude.json`,
history, projects, plugins, and backups stay on the host. It also leaves out any entry whose name
starts with a dot.

The bundle's `settings.json` holds these keys of the host's settings when they are set: `model`,
`effortLevel`, `advisorModel`, `outputStyle`, `autoCompactWindow`, `autoMode`, `attribution`,
`includeCoAuthoredBy`, `skipAutoPermissionPrompt`, `skipWorkflowUsageWarning`, `editorMode`, `tui`,
`permissions`, `statusLine`, and `env`. atc changes three of them on the way:

- `permissions.defaultMode` is always `auto`. Claude Code honours that mode only in user settings.
  `permissions.blockReadsOutsideWorkingDirectories` never ships, since it refuses reads an
  unattended session needs. `permissions.deny` gains `Read` rules for the session's own
  `.claude.json` and for `~/.claude/.credentials.json`, after the host's own rules.
- `statusLine.command` points at the guest copy of a script the bundle ships. For `~/.claude`, atc
  also rewrites the `~/.claude` and `$HOME/.claude` spellings. atc's own statusline runs that
  command first, as it does on the host.
- `env` keeps `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` alone, since any other variable can hold a
  credential.

A repo's own `.claude/settings.json` and `.claude/settings.local.json` rank above the bundle, so
Claude Code's precedence gives a repo value over a bundle value. The `--settings` file atc writes
holds only the hooks, the statusline, the placeholder, and the entry's own `settings` and `env`, so
it never carries a bundle value above the repo's. A value the entry sets there does rank above the
repo's.

atc reads the host's folder at each launch, so a spawn or a revive after you change it starts with
the change. A running session keeps the bundle it started with. On each launch the guest replaces
every bundle entry in the session's config folder, so an entry you remove from the host leaves the
session too. The state Claude Code writes beside the bundle, `.claude.json` among it, stays.
